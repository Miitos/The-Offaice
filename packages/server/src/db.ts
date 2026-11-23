import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE agents (
    name           TEXT PRIMARY KEY,
    role           TEXT NOT NULL,
    capabilities   TEXT NOT NULL,             -- JSON array
    model          TEXT NOT NULL,
    share          REAL NOT NULL,             -- % du budget équipe
    worktree       TEXT,
    first_name     TEXT,
    last_name      TEXT,
    favorite_movie TEXT,
    favorite_music TEXT,
    room           TEXT NOT NULL DEFAULT 'desk' CHECK (room IN ('desk','meeting','break','rest')),
    bubble         TEXT,
    bubble_at      INTEGER,
    agent_id       TEXT,                      -- dernier agent_id Claude Code vu dans les hooks
    updated_at     INTEGER NOT NULL
  );

  CREATE TABLE cards (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    col               TEXT NOT NULL,
    assignee          TEXT REFERENCES agents(name),
    blocked_from      TEXT,                   -- colonne d'origine quand col = BLOCKED
    created_by        TEXT NOT NULL,          -- nom d'agent ou 'user'
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    entered_col_at    INTEGER NOT NULL
  );
  CREATE INDEX cards_col ON cards(col);
  CREATE INDEX cards_assignee ON cards(assignee);

  -- Historique complet : création, mouvements (acceptés ou refusés), assignations, commentaires.
  CREATE TABLE card_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id   INTEGER NOT NULL REFERENCES cards(id),
    at        INTEGER NOT NULL,
    actor     TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('created','moved','move_refused','assigned','commented')),
    from_col  TEXT,
    to_col    TEXT,
    detail    TEXT
  );
  CREATE INDEX card_events_card ON card_events(card_id, at);
  CREATE INDEX card_events_at ON card_events(at);

  CREATE TABLE comments (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id  INTEGER NOT NULL REFERENCES cards(id),
    at       INTEGER NOT NULL,
    author   TEXT NOT NULL,
    kind     TEXT NOT NULL CHECK (kind IN ('note','review')),
    body     TEXT NOT NULL
  );
  CREATE INDEX comments_card ON comments(card_id, at);

  CREATE TABLE room_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent      TEXT NOT NULL REFERENCES agents(name),
    at         INTEGER NOT NULL,
    from_room  TEXT,
    to_room    TEXT NOT NULL,
    source     TEXT NOT NULL,                 -- 'agent' (enter_room), 'hook', 'system'
    reason     TEXT
  );
  CREATE INDEX room_events_agent ON room_events(agent, at);

  CREATE TABLE break_posts (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    agent  TEXT NOT NULL REFERENCES agents(name),
    at     INTEGER NOT NULL,
    body   TEXT NOT NULL
  );
  CREATE INDEX break_posts_agent ON break_posts(agent, at);

  CREATE TABLE break_lock_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      INTEGER NOT NULL,
    locked  INTEGER NOT NULL,
    actor   TEXT NOT NULL,                    -- 'user', 'auto', 'reset'
    reason  TEXT
  );

  CREATE TABLE quota_samples (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    at                   INTEGER NOT NULL,
    source               TEXT NOT NULL,
    five_hour_pct        REAL,
    five_hour_resets_at  INTEGER,
    seven_day_pct        REAL,
    seven_day_resets_at  INTEGER
  );
  CREATE INDEX quota_samples_at ON quota_samples(at);

  CREATE TABLE hook_events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       INTEGER NOT NULL,
    event    TEXT NOT NULL,
    agent    TEXT,
    payload  TEXT NOT NULL
  );
  CREATE INDEX hook_events_at ON hook_events(at);

  CREATE TABLE kv (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  `,
  // v2 — the break room is a conversation: replies + what each agent has read.
  `
  ALTER TABLE break_posts ADD COLUMN reply_to INTEGER REFERENCES break_posts(id);
  ALTER TABLE agents ADD COLUMN break_read_id INTEGER;  -- last break post the agent has seen
  `,
  // v3 — social life: hobbies / dislikes the agents give themselves, opinions on each other and on the creator.
  `
  CREATE TABLE agent_traits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent       TEXT NOT NULL REFERENCES agents(name),
    kind        TEXT NOT NULL CHECK (kind IN ('hobby','dislike')),
    label       TEXT NOT NULL,
    added_at    INTEGER NOT NULL,
    removed_at  INTEGER
  );
  CREATE INDEX agent_traits_agent ON agent_traits(agent, kind);

  -- Full history: the latest row per (author, about) is the current opinion.
  CREATE TABLE opinions (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    author  TEXT NOT NULL REFERENCES agents(name),
    about   TEXT NOT NULL,                    -- agent name or 'creator'
    body    TEXT NOT NULL,
    at      INTEGER NOT NULL
  );
  CREATE INDEX opinions_pair ON opinions(author, about, at);
  CREATE INDEX opinions_about ON opinions(about, at);

  -- Agents' feedback on the quality / level of detail of a requested task (history kept).
  CREATE TABLE card_feedback (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id  INTEGER NOT NULL REFERENCES cards(id),
    author   TEXT NOT NULL REFERENCES agents(name),
    clarity  INTEGER NOT NULL CHECK (clarity BETWEEN 1 AND 5),
    comment  TEXT NOT NULL,
    at       INTEGER NOT NULL
  );
  CREATE INDEX card_feedback_card ON card_feedback(card_id, at);
  `,
  // v4 — retrospectives, quota shares changed by the team, token usage from transcripts.
  `
  ALTER TABLE agents ADD COLUMN share_override REAL;   -- set by a retrospective decision

  CREATE TABLE retros (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  INTEGER NOT NULL,
    started_by  TEXT NOT NULL,
    topic       TEXT,
    status      TEXT NOT NULL CHECK (status IN ('open','closed')),
    closed_at   INTEGER,
    closed_by   TEXT,
    summary     TEXT
  );

  CREATE TABLE retro_messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    retro_id  INTEGER NOT NULL REFERENCES retros(id),
    agent     TEXT NOT NULL,
    at        INTEGER NOT NULL,
    body      TEXT NOT NULL,
    reply_to  INTEGER REFERENCES retro_messages(id)
  );
  CREATE INDEX retro_messages_retro ON retro_messages(retro_id, id);

  CREATE TABLE retro_proposals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    retro_id    INTEGER NOT NULL REFERENCES retros(id),
    author      TEXT NOT NULL,
    at          INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('quota','process','other')),
    title       TEXT NOT NULL,
    details     TEXT NOT NULL,
    payload     TEXT,                          -- JSON, e.g. {"shares":{"dev1":25,...}}
    status      TEXT NOT NULL CHECK (status IN ('open','adopted','rejected')),
    applied_at  INTEGER,
    reverted_at INTEGER,
    reverted_by TEXT
  );
  CREATE INDEX retro_proposals_retro ON retro_proposals(retro_id);

  CREATE TABLE retro_votes (
    proposal_id INTEGER NOT NULL REFERENCES retro_proposals(id),
    agent       TEXT NOT NULL,
    vote        TEXT NOT NULL CHECK (vote IN ('for','against')),
    at          INTEGER NOT NULL,
    PRIMARY KEY (proposal_id, agent)
  );

  CREATE TABLE team_agreements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id  INTEGER REFERENCES retro_proposals(id),
    title        TEXT NOT NULL,
    text         TEXT NOT NULL,
    at           INTEGER NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE share_changes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           INTEGER NOT NULL,
    source       TEXT NOT NULL,                -- 'retro' | 'revert'
    proposal_id  INTEGER REFERENCES retro_proposals(id),
    before       TEXT NOT NULL,                -- JSON {agent: share}
    after        TEXT NOT NULL
  );

  -- One row per assistant message found in the team's transcripts.
  CREATE TABLE usage_records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    message_key     TEXT NOT NULL UNIQUE,      -- file + message id: no double counting
    agent           TEXT NOT NULL,
    at              INTEGER NOT NULL,
    model           TEXT,
    input           INTEGER NOT NULL,
    output          INTEGER NOT NULL,
    cache_creation  INTEGER NOT NULL,
    cache_read      INTEGER NOT NULL,
    weighted        REAL NOT NULL,
    in_break        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX usage_records_agent_at ON usage_records(agent, at);
  CREATE INDEX usage_records_at ON usage_records(at);

  CREATE TABLE transcript_offsets (
    file    TEXT PRIMARY KEY,
    offset  INTEGER NOT NULL,
    agent   TEXT
  );
  `
,
  `
  -- Multi-project: each card belongs to a project (id from office.config.json projects).
  ALTER TABLE cards ADD COLUMN project TEXT;
  CREATE INDEX cards_project ON cards(project);
  `
];

export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 3000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
