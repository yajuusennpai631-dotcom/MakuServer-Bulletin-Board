require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require("discord.js");

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : (process.env.DATABASE_URL ? { rejectUnauthorized: false } : false)
});

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const categories = ["ゲーム", "コミュニティ", "技術・プログラミング", "創作", "学習", "その他"];
const clean = (value, max) => String(value ?? "").trim().slice(0, max);
const validInvite = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["discord.gg", "www.discord.gg", "discord.com", "www.discord.com"].includes(url.hostname) &&
      (url.hostname.includes("discord.gg") ? url.pathname.length > 1 : url.pathname.startsWith("/invite/"));
  } catch { return false; }
};
const isAdminId = (id) => (process.env.ADMIN_USER_IDS || "").split(",").map(x => x.trim()).filter(Boolean).includes(id);
const requireAdminToken = (req, res, next) => {
  const expected = process.env.ADMIN_TOKEN;
  const provided = req.get("x-admin-token") || "";
  if (!expected || provided.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return res.status(401).json({ error: "管理者認証に失敗しました。" });
  }
  next();
};

async function initDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Add a Railway PostgreSQL service and reference its DATABASE_URL.");
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS servers (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(80) NOT NULL,
      description VARCHAR(1000) NOT NULL,
      invite_url VARCHAR(300) NOT NULL,
      category VARCHAR(60) NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      owner_discord_id VARCHAR(32),
      status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS servers_status_created_idx ON servers(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS servers_category_idx ON servers(category);
  `);
}

app.get("/api/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, service: "MakuServer Bulletin Board" }); }
  catch { res.status(503).json({ ok: false }); }
});

app.get("/api/categories", (_req, res) => res.json(categories));

app.get("/api/servers", async (req, res, next) => {
  try {
    const q = clean(req.query.q, 100);
    const category = clean(req.query.category, 60);
    const tag = clean(req.query.tag, 30);
    const values = [];
    const where = ["status = 'approved'"];
    if (q) {
      values.push(`%${q.replace(/[\\%_]/g, "\\$&")}%`);
      where.push(`(name ILIKE $VALUES$ OR description ILIKE $VALUES$ OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE t ILIKE $VALUES$))`.replaceAll("$VALUES$", "$" + values.length));
    }
    if (category && categories.includes(category)) { values.push(category); where.push(`category = $${values.length}`); }
    if (tag) { values.push(tag); where.push(`$ ${values.length} = ANY(tags)`.replace("$ ", "$")); }
    const result = await pool.query(
      `SELECT id, name, description, invite_url, category, tags, created_at FROM servers WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 100`,
      values
    );
    res.json(result.rows);
  } catch (err) { next(err); }
});

app.post("/api/servers", async (req, res, next) => {
  try {
    const name = clean(req.body.name, 80);
    const description = clean(req.body.description, 1000);
    const invite_url = clean(req.body.invite_url, 300);
    const category = clean(req.body.category, 60);
    const owner_discord_id = clean(req.body.owner_discord_id, 32) || null;
    const tags = [...new Set((Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags || "").split(","))
      .map(t => clean(t, 24).replace(/[^\p{L}\p{N}_ -]/gu, "").trim()).filter(Boolean))].slice(0, 8);
    if (name.length < 2 || description.length < 10) return res.status(400).json({ error: "サーバー名は2文字以上、説明は10文字以上で入力してください。" });
    if (!categories.includes(category)) return res.status(400).json({ error: "カテゴリを選択してください。" });
    if (!validInvite(invite_url)) return res.status(400).json({ error: "有効な Discord 招待 URL を入力してください。" });
    if (owner_discord_id && !/^\d{17,20}$/.test(owner_discord_id)) return res.status(400).json({ error: "DiscordユーザーIDの形式が正しくありません。" });
    const result = await pool.query(
      "INSERT INTO servers (name, description, invite_url, category, tags, owner_discord_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, description, invite_url, category, tags, status, created_at",
      [name, description, invite_url, category, tags, owner_discord_id]
    );
    const server = result.rows[0];
    await notifyModerators(server).catch(err => console.error("Moderation notification failed:", err.message));
    res.status(201).json({ message: "投稿を受け付けました。管理者の審査後に掲載されます。", server });
  } catch (err) { next(err); }
});

app.get("/api/admin/pending", requireAdminToken, async (_req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM servers WHERE status='pending' ORDER BY created_at ASC LIMIT 100");
    res.json(result.rows);
  } catch (err) { next(err); }
});

app.post("/api/admin/servers/:id/:action", requireAdminToken, async (req, res, next) => {
  try {
    const action = req.params.action;
    if (!["approve", "reject", "delete"].includes(action)) return res.status(400).json({ error: "操作が不正です。" });
    const status = action === "approve" ? "approved" : action === "reject" ? "rejected" : null;
    const result = status
      ? await pool.query("UPDATE servers SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING id,name,status", [status, req.params.id])
      : await pool.query("DELETE FROM servers WHERE id=$1 RETURNING id,name,status", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "投稿が見つかりません。" });
    res.json({ message: action === "approve" ? "掲載を承認しました。" : action === "reject" ? "投稿を却下しました。" : "投稿を削除しました。", server: result.rows[0] });
  } catch (err) { next(err); }
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "サーバー内部エラーが発生しました。" });
});

let bot;
async function notifyModerators(server) {
  if (!bot?.isReady() || !process.env.DISCORD_REVIEW_CHANNEL_ID) return;
  const channel = await bot.channels.fetch(process.env.DISCORD_REVIEW_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) return;
  const embed = new EmbedBuilder().setTitle("新しいサーバー掲載申請").setColor(0x5865f2)
    .addFields(
      { name: "ID", value: String(server.id), inline: true },
      { name: "サーバー名", value: server.name, inline: true },
      { name: "説明", value: server.description || "—" },
      { name: "カテゴリ", value: server.category || "—", inline: true },
      { name: "招待リンク", value: server.invite_url || "—" }
    ).setTimestamp();
  await channel.send({ embeds: [embed], content: "審査はBotの `/approve` または `/reject` コマンドで行えます。" });
}

async function startBot() {
  if (!process.env.DISCORD_TOKEN) {
    console.warn("DISCORD_TOKEN is not set; starting web-only mode.");
    return;
  }
  bot = new Client({ intents: [GatewayIntentBits.Guilds] });
  const commands = [
    new SlashCommandBuilder().setName("pending").setDescription("審査待ちのサーバー投稿を表示"),
    new SlashCommandBuilder().setName("approve").setDescription("投稿を承認して掲載").addStringOption(o => o.setName("id").setDescription("投稿ID").setRequired(true)),
    new SlashCommandBuilder().setName("reject").setDescription("投稿を却下").addStringOption(o => o.setName("id").setDescription("投稿ID").setRequired(true)),
    new SlashCommandBuilder().setName("remove").setDescription("掲載中または申請中の投稿を削除").addStringOption(o => o.setName("id").setDescription("投稿ID").setRequired(true))
  ].map(c => c.toJSON());
  bot.once("ready", async () => {
    console.log(`Discord bot logged in as ${bot.user.tag}`);
    try {
      const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
      await rest.put(Routes.applicationCommands(bot.user.id), { body: commands });
      console.log("Registered global slash commands.");
    } catch (err) { console.error("Slash command registration failed:", err.message); }
  });
  bot.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (!isAdminId(interaction.user.id) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: "このコマンドを実行する権限がありません。", ephemeral: true });
    }
    try {
      if (interaction.commandName === "pending") {
        const result = await pool.query("SELECT id,name,description,category,invite_url,tags FROM servers WHERE status='pending' ORDER BY created_at ASC LIMIT 10");
        if (!result.rowCount) return interaction.reply({ content: "審査待ちの投稿はありません。", ephemeral: true });
        const embed = new EmbedBuilder().setTitle("審査待ちの投稿").setColor(0xfee75c)
          .setDescription(result.rows.map(s => `**#${s.id} · ${s.name}**\n${s.category} · ${s.description}\nタグ: ${s.tags.join(", ") || "なし"}\n${s.invite_url}`).join("\n\n"));
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      const id = interaction.options.getString("id", true);
      if (!/^\d+$/.test(id)) return interaction.reply({ content: "投稿IDは数字で指定してください。", ephemeral: true });
      if (interaction.commandName === "approve" || interaction.commandName === "reject") {
        const status = interaction.commandName === "approve" ? "approved" : "rejected";
        const result = await pool.query("UPDATE servers SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING id,name", [status, id]);
        if (!result.rowCount) return interaction.reply({ content: "投稿が見つかりません。", ephemeral: true });
        return interaction.reply({ content: `投稿 #${id}（${result.rows[0].name}）を${status === "approved" ? "承認しました。サイトに掲載されます。" : "却下しました。"}`, ephemeral: true });
      }
      if (interaction.commandName === "remove") {
        const result = await pool.query("DELETE FROM servers WHERE id=$1 RETURNING name", [id]);
        return interaction.reply({ content: result.rowCount ? `投稿 #${id}（${result.rows[0].name}）を削除しました。` : "投稿が見つかりません。", ephemeral: true });
      }
    } catch (err) {
      console.error("Discord interaction failed:", err);
      if (interaction.deferred || interaction.replied) await interaction.followUp({ content: "処理に失敗しました。ログを確認してください。", ephemeral: true }).catch(() => {});
      else await interaction.reply({ content: "処理に失敗しました。ログを確認してください。", ephemeral: true }).catch(() => {});
    }
  });
  await bot.login(process.env.DISCORD_TOKEN);
}

(async () => {
  await initDb();
  app.listen(port, "0.0.0.0", () => console.log(`Web server listening on ${port}`));
  await startBot();
})().catch(err => { console.error("Startup failed:", err); process.exit(1); });
