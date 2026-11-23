import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePaths } from '../src/config.js';
import { Settings } from '../src/domain/settings.js';
import { makeConfig, makeOffice } from './helpers.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-projects-'));
  const repo = (name: string, branch = 'main') => {
    const p = path.join(dir, name);
    fs.mkdirSync(p);
    execFileSync('git', ['init', '-q', '-b', branch], { cwd: p });
    fs.writeFileSync(path.join(p, 'a.txt'), 'x');
    execFileSync('git', ['add', '-A'], { cwd: p });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: p });
    return p;
  };
  const meteo = repo('meteo');
  const other = repo('autre', 'master');
  const base = makeConfig();
  const raw = { ...base, team: { repoPath: './meteo', leadAgent: 'lead' }, projects: [{ id: 'meteo', name: 'Météo', repoPath: './meteo', mainBranch: 'main' }] };
  const file = path.join(dir, 'office.config.json');
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  const cfg = resolvePaths(JSON.parse(JSON.stringify({ ...base, team: raw.team, projects: raw.projects })), dir);
  const app = makeOffice(cfg);
  const settings = new Settings(app.office, { configFile: file, setupScript: null, retro: app.retro });
  return { ...app, dir, file, meteo, other, settings };
}

describe('projects', () => {
  it('puts worktrees next to the active project', () => {
    const { office, meteo } = setup();
    expect(office.activeProject).toBe('meteo');
    expect(office.config.agents.find((a) => a.name === 'dev1')!.worktree).toBe(path.join(path.dirname(meteo), 'meteo-wt-dev1'));
  });

  it('adds a project, refuses a plain folder or a missing branch', () => {
    const { settings, other, dir } = setup();
    fs.mkdirSync(path.join(dir, 'plain'));
    fs.writeFileSync(path.join(dir, 'plain', 'f.txt'), 'x');
    expect(() => settings.addProject({ name: 'Plain', repoPath: path.join(dir, 'plain') })).toThrow(/pas un dépôt git/);
    expect(() => settings.addProject({ name: 'Autre', repoPath: other })).toThrow(/branche « main » n'existe pas/);
    const res = settings.addProject({ name: 'Autre projet', repoPath: other, mainBranch: 'master' });
    expect(res.project).toBe('autre-projet');
    expect(() => settings.addProject({ name: 'Encore', repoPath: other, mainBranch: 'master' })).toThrow(/déjà un projet/);
  });

  it('keeps each project its own board; agents only touch the active one', () => {
    const { office, settings, other } = setup();
    settings.addProject({ name: 'Autre', repoPath: other, mainBranch: 'master' });
    const mine = office.createCard('lead', { title: 'Météo', column: 'TODO' });
    const theirs = office.createCard('user', { title: 'Pour plus tard', project: 'autre' });
    expect(office.listBoard().flatMap((c) => c.cards).map((c) => c.id)).toEqual([mine.id]);
    expect(office.listBoard('autre').flatMap((c) => c.cards).map((c) => c.id)).toEqual([theirs.id]);
    expect(() => office.moveCard('lead', theirs.id, 'TODO')).toThrow(/n'est pas le projet actif/);
  });

  it('switches project: confirmation when work is open, then config, worktrees and board follow', async () => {
    const { office, settings, other, file } = setup();
    settings.addProject({ name: 'Autre', repoPath: other, mainBranch: 'master' });
    office.createCard('lead', { title: 'En cours', column: 'TODO' });
    await expect(settings.activateProject('autre')).rejects.toThrow(/en cours/);
    const res = await settings.activateProject('autre', { force: true });
    expect(res.relaunch.cwd).toBe(other);
    expect(office.activeProject).toBe('autre');
    expect(office.config.team.repoPath).toBe(other);
    expect(office.agentRow('dev1').worktree).toBe(path.join(path.dirname(other), 'autre-wt-dev1'));
    expect(office.listBoard().flatMap((c) => c.cards)).toHaveLength(0);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.team.activeProject).toBe('autre');
    expect(() => settings.removeProject('autre')).toThrow(/projet actif/);
    expect(() => settings.removeProject('meteo')).toThrow(/carte/);
  });
});
