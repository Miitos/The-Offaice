#!/usr/bin/env node
// The OffAIce — installe l'équipe dans le projet actif (team.activeProject d'office.config.json) :
// dépôt git + branche principale, CLAUDE.md d'équipe, .claude/agents/*, .claude/settings.json
// (agent teams, hooks, statusline, permissions), .mcp.json (serveur office), un worktree par dev.
// Relançable : les fichiers générés sont réécrits. Dans un projet existant, rien n'est écrasé :
// un CLAUDE.md à lui laisse la place à .claude/CLAUDE.md, ses settings.json et .mcp.json sont
// complétés, et les fichiers de l'équipe restent hors de git (.git/info/exclude) au lieu d'être commités.
//
//   node scripts/setup-team.mjs [--config office.config.json] [--force] [--dry-run]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const FORCE = flag('--force');
const DRY = flag('--dry-run');
const MARK = 'agent-office:generated';

const configFile = path.resolve(opt('--config', path.join(ROOT, 'office.config.json')));
const configDir = path.dirname(configFile);
const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const projects = cfg.projects?.length ? cfg.projects : [{ id: 'default', name: 'default', repoPath: cfg.team?.repoPath ?? '../office-team', mainBranch: 'main' }];
const project = projects.find((p) => p.id === cfg.team?.activeProject) ?? projects[0];
const repo = path.resolve(configDir, project.repoPath);
const MAIN = project.mainBranch ?? 'main';
const officeUrl = `http://${cfg.server?.host ?? '127.0.0.1'}:${cfg.server?.port ?? 4317}`;
const fwd = (p) => p.replace(/\\/g, '/');
const permPath = (p) => '//' + fwd(p).replace(/^([A-Za-z]):/, '$1');
const hookScript = fwd(path.join(ROOT, 'packages', 'hooks', 'office-hook.mjs'));
const statusScript = fwd(path.join(ROOT, 'packages', 'hooks', 'statusline.mjs'));
const mcpEntry = fwd(path.join(ROOT, 'packages', 'mcp', 'dist', 'index.js'));

const log = (...a) => console.log(...a);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A dev's worktree sits next to the project: <projet>-wt-<agent> (same rule as the server).
const agents = cfg.agents.map((a) => ({
  ...a,
  worktree: a.worktree ? path.join(path.dirname(repo), `${path.basename(repo)}-wt-${a.name}`) : null,
  branch: a.worktree ? `${a.name}/work` : null
}));
const templateFor = (a) =>
  a.capabilities.includes('lead') ? 'lead.md' : a.capabilities.includes('designer') ? 'designer.md' : a.capabilities.includes('architect') ? 'archi.md' : a.capabilities.includes('dev') ? 'dev.md' : a.capabilities.includes('reviewer') ? 'reviewer.md' : 'tester.md';

function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

const written = [];
const isOurs = (file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(MARK);
/** Our keys win, the project's own keys stay (permissions.allow is merged). */
function mergeJson(file, ours) {
  if (!fs.existsSync(file)) return ours;
  let cur;
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return ours;
  }
  const out = { ...cur, ...ours };
  if (ours.env) out.env = { ...(cur.env ?? {}), ...ours.env };
  if (ours.mcpServers) out.mcpServers = { ...(cur.mcpServers ?? {}), ...ours.mcpServers };
  if (ours.permissions) {
    const allow = [...new Set([...(cur.permissions?.allow ?? []).filter((r) => !/^(Edit|Write)\(/.test(r) || ours.permissions.allow.includes(r)), ...ours.permissions.allow])];
    const deny = [...new Set([...(cur.permissions?.deny ?? []), ...ours.permissions.deny])];
    out.permissions = { ...(cur.permissions ?? {}), allow, deny };
  }
  return out;
}
function writeGenerated(rel, content, { isJson = false } = {}) {
  const file = path.join(repo, rel);
  if (isJson) content = mergeJson(file, content);
  const body = isJson ? JSON.stringify(content, null, 2) + '\n' : content.startsWith('---') ? content.replace(/^---\r?\n/,`---\n# ${MARK}\n`) : `<!-- ${MARK} -->\n${content}`;
  if (fs.existsSync(file)) {
    const cur = fs.readFileSync(file, 'utf8');
    // JSON files are merged above, never lost.
    const ours = isJson || cur.includes(MARK);
    if (!ours && !FORCE) {
      console.error(`  ✗ ${rel} existe déjà et n'a pas été généré par The OffAIce : je n'y touche pas (--force pour l'écraser).`);
      return;
    }
    if (cur === body) return;
  }
  if (!DRY) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body, 'utf8');
  }
  written.push(rel);
}
function writeIfMissing(rel, content) {
  const file = path.join(repo, rel);
  if (fs.existsSync(file)) return;
  if (!DRY) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
  written.push(rel);
}

log(`The OffAIce — installation de l'équipe`);
log(`  dépôt   ${repo}`);
log(`  serveur ${officeUrl}`);
if (!fs.existsSync(mcpEntry)) log(`  ! ${mcpEntry} absent : lance d'abord « npm run build -w @agent-office/mcp ».`);

// 1. Dépôt git local, branche principale.
if (!DRY) fs.mkdirSync(repo, { recursive: true });
if (!fs.existsSync(path.join(repo, '.git'))) {
  if (!DRY) git(repo, 'init', '-b', MAIN);
  log(`  ✓ dépôt git créé (branche ${MAIN}, aucun remote)`);
}
const hasCommits = (() => {
  try {
    git(repo, 'rev-parse', '--verify', 'HEAD');
    return true;
  } catch {
    return false;
  }
})();
const tracked = (rel) => {
  try {
    return !!git(repo, 'ls-files', '--', rel.split(path.sep).join('/'));
  } catch {
    return false;
  }
};
// The project's own CLAUDE.md stays untouched: the team's goes to .claude/CLAUDE.md (read too by Claude Code).
const rootClaude = path.join(repo, 'CLAUDE.md');
const claudeRel = fs.existsSync(rootClaude) && !isOurs(rootClaude) ? path.join('.claude', 'CLAUDE.md') : 'CLAUDE.md';
// Same for a settings.json of its own: the team's settings go to settings.local.json (Claude Code merges both).
const projSettings = path.join(repo, '.claude', 'settings.json');
const ownsSettings = !fs.existsSync(projSettings) || fs.readFileSync(projSettings, 'utf8').includes(fwd(ROOT));
const settingsRel = path.join('.claude', ownsSettings ? 'settings.json' : 'settings.local.json');
/** In HEAD and written by us before: the only kind of tracked file we commit again. */
const committedByUs = (rel) => {
  try {
    const head = git(repo, 'show', `HEAD:${rel.split(path.sep).join('/')}`);
    return head.includes(MARK) || head.includes(fwd(ROOT));
  } catch {
    return false;
  }
};
log(`  projet  ${project.name} (branche ${MAIN})`);

// 2. Fichiers de l'équipe.
const table = [
  '| Agent | Rôle | Modèle | Part du budget | Worktree (branche) |',
  '|---|---|---|---|---|',
  ...agents.map((a) => `| \`${a.name}\` | ${a.role} | ${a.model} | ${a.share} % | ${a.worktree ? `\`${fwd(a.worktree)}\` (\`${a.branch}\`)` : '—'} |`)
].join('\n');
writeGenerated(claudeRel, fill(fs.readFileSync(path.join(ROOT, 'team-template', 'CLAUDE.md'), 'utf8'), { AGENT_TABLE: table, REPO: fwd(repo), MAIN, AGREEMENTS: claudeRel === 'CLAUDE.md' ? '@.claude/team-agreements.md' : '@team-agreements.md' }));
for (const a of agents) {
  const tpl = fs.readFileSync(path.join(ROOT, 'team-template', 'agents', templateFor(a)), 'utf8');
  writeGenerated(path.join('.claude', 'agents', `${a.name}.md`), fill(tpl, { NAME: a.name, MODEL: a.model, REPO: fwd(repo), WORKTREE: a.worktree ? fwd(a.worktree) : '', BRANCH: a.branch ?? '', MAIN, WATCHER: fwd(path.join(ROOT, 'packages', 'hooks', 'watch-backlog.mjs')) }));
}
// Runtime state, rewritten by the server: not versioned.
writeIfMissing(path.join('.claude', 'team-agreements.md'), '# Accords d\'équipe\n\nAucun accord pour le moment.\n');
if (!hasCommits) writeIfMissing('.gitignore', 'node_modules/\n.claude/team-agreements.md\n.claude/settings.local.json\n');
if (!DRY && fs.existsSync(path.join(repo, '.git'))) {
  try {
    git(repo, 'rm', '--cached', '--quiet', path.join('.claude', 'team-agreements.md'));
  } catch {
    /* not tracked */
  }
}
writeIfMissing(path.join('docs', 'design', '.gitkeep'), '');
if (!hasCommits) writeIfMissing('README.md', '# Projet de l\'équipe The OffAIce\n\nDépôt local de travail de l\'équipe. Voir CLAUDE.md.\n');

const hook = { type: 'command', command: `node "${hookScript}"`, timeout: 15 };
const allow = [
  'mcp__office__*',
  'Read',
  'Glob',
  'Grep',
  `Edit(${permPath(repo)}/**)`,
  `Write(${permPath(repo)}/**)`,
  ...agents.filter((a) => a.worktree).flatMap((a) => [`Edit(${permPath(a.worktree)}/**)`, `Write(${permPath(a.worktree)}/**)`]),
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git show*)',
  'Bash(git add*)',
  'Bash(git commit*)',
  'Bash(git merge*)',
  'Bash(git branch*)',
  'Bash(git -C *)',
  'Bash(cd *)',
  'Bash(npm test*)',
  'Bash(npm run *)',
  'Bash(npm install*)',
  'Bash(npx *)',
  'Bash(node *)',
  'Bash(ls*)'
];
writeGenerated(
  settingsRel,
  {
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', OFFICE_URL: officeUrl },
    disableClaudeAiConnectors: true,
    enableAllProjectMcpServers: true,
    permissions: { allow, deny: ['Bash(git push*)', 'Bash(git remote add*)'] },
    statusLine: { type: 'command', command: `node "${statusScript}"`, refreshInterval: 15 },
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [hook] }],
      TeammateIdle: [{ hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      SubagentStart: [{ hooks: [hook] }]
    }
  },
  { isJson: true }
);
writeGenerated('.mcp.json', { mcpServers: { office: { type: 'stdio', command: 'node', args: [mcpEntry], env: { OFFICE_URL: officeUrl }, // Never deferred behind tool search: teammates with a fixed tools list could not load them.
      alwaysLoad: true } } }, { isJson: true });

// 3. Git. A new repo gets an initial commit (the worktrees start from it). In an existing project,
// the team's files are only committed if they already were; the others stay out of git (info/exclude).
if (!DRY) {
  const all = [...new Set(written)].map((r) => r.split(path.sep).join('/'));
  const team = [claudeRel, path.join('.claude', 'agents'), path.join('.claude', 'team-agreements.md'), settingsRel, '.mcp.json'].map((r) => r.split(path.sep).join('/'));
  // Never commit into the project's history what it had before us (its own .mcp.json, say).
  const toCommit = hasCommits ? all.filter((r) => committedByUs(r)) : all;
  for (const r of all.filter((x) => hasCommits && tracked(x) && !committedByUs(x))) log(`  ! ${r} appartient au projet : complété pour l'équipe mais pas commité (à vérifier avec git diff).`);
  const toExclude = hasCommits ? team.filter((r) => !tracked(r)) : [path.posix.join('.claude', 'team-agreements.md')];
  if (toExclude.length) {
    const ex = path.join(repo, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(ex), { recursive: true });
    const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
    const add = toExclude.map((r) => '/' + r).filter((r) => !cur.split(/\r?\n/).includes(r));
    if (add.length) {
      fs.writeFileSync(ex, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '# The OffAIce\n' + add.join('\n') + '\n', 'utf8');
      log(`  ✓ hors de git (.git/info/exclude) : ${add.join(', ')}`);
    }
  }
  const status = toCommit.length ? git(repo, 'status', '--porcelain', '--', ...toCommit) : '';
  if (status) {
    git(repo, 'add', '--', ...toCommit);
    git(repo, '-c', 'user.name=The OffAIce', '-c', 'user.email=agent-office@localhost', 'commit', '-m', "The OffAIce : configuration de l'équipe");
    log(`  ✓ fichiers de l'équipe commités sur ${MAIN}`);
  }
}

// 4. Un worktree par dev.
for (const a of agents.filter((x) => x.worktree)) {
  if (fs.existsSync(a.worktree)) {
    log(`  · worktree ${a.name} déjà présent : ${fwd(a.worktree)}`);
    continue;
  }
  if (!DRY) {
    const branches = git(repo, 'branch', '--list', a.branch);
    if (branches) git(repo, 'worktree', 'add', a.worktree, a.branch);
    else git(repo, 'worktree', 'add', '-b', a.branch, a.worktree, MAIN);
  }
  log(`  ✓ worktree ${a.name} : ${fwd(a.worktree)} (branche ${a.branch})`);
}

log(written.length ? `  ✓ écrits : ${written.join(', ')}` : '  · rien à réécrire');
log('');
log('Ensuite :');
log(`  1. serveur  : cd ${fwd(ROOT)} && npm run dev:server`);
log(`  2. équipe   : cd ${fwd(repo)} && claude --agent lead --no-chrome`);
log("     attends l'invite, puis tape ta consigne (jamais en argument : les coéquipiers n'auraient pas les outils office)");
log('     (première fois : accepte la confiance du dossier et le serveur MCP « office »)');
