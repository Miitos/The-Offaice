import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Settings } from '../src/domain/settings.js';
import { makeConfig, makeOffice } from './helpers.js';

const withDesigner = () =>
  makeConfig({
    agents: [
      { name: 'lead', role: 'Lead', capabilities: ['lead'], model: 'sonnet', share: 15 },
      { name: 'designer', role: 'Designer', capabilities: ['designer'], model: 'claude-opus-5-5', share: 10 },
      { name: 'archi', role: 'Archi', capabilities: ['architect'], model: 'opus', share: 10 },
      { name: 'dev1', role: 'Dev', capabilities: ['dev'], model: 'sonnet', share: 22.5, worktree: 'D:/tmp/wt1' },
      { name: 'dev2', role: 'Dev', capabilities: ['dev'], model: 'sonnet', share: 22.5, worktree: 'D:/tmp/wt2' },
      { name: 'reviewer', role: 'Reviewer', capabilities: ['reviewer'], model: 'sonnet', share: 10 },
      { name: 'tester', role: 'Testeur', capabilities: ['tester'], model: 'sonnet', share: 10 }
    ]
  });

describe('designer', () => {
  it('is the only one who takes a card out of TODO', () => {
    const { office } = makeOffice(withDesigner());
    const c = office.createCard('lead', { title: 'Écran météo', column: 'TODO' });
    expect(() => office.moveCard('lead', c.id, 'TO DESIGN')).toThrow(/Seul le designer/);
    expect(() => office.moveCard('dev1', c.id, 'IN PROGRESS')).toThrow(/Seul le designer/);
    expect(office.moveCard('designer', c.id, 'TO DESIGN').col).toBe('TO_DESIGN');
  });

  it('can block a card with questions, which goes back to TODO once answered', () => {
    const { office } = makeOffice(withDesigner());
    const c = office.createCard('lead', { title: 'Flou', column: 'TODO' });
    office.commentCard('designer', c.id, 'Questions pour Le créateur : 1. Pour qui ?');
    office.moveCard('designer', c.id, 'BLOCKED', 'questions métier');
    office.commentCard('user', c.id, 'Pour les skieurs du week-end.');
    expect(office.getCard(c.id).comments.map((m) => m.author)).toEqual(['designer', 'user']);
    expect(office.moveCard('designer', c.id, 'TODO').col).toBe('TODO');
  });

  it('hands TODO cards to the designer, and TO DESIGN cards assigned to them back for the mockup', () => {
    const { office } = makeOffice(withDesigner());
    const c = office.createCard('lead', { title: 'UI', column: 'TODO' });
    expect(office.handoffFor(office.getCard(c.id))?.to).toEqual(['designer']);
    office.moveCard('designer', c.id, 'TO DESIGN');
    expect(office.handoffFor(office.getCard(c.id))?.to).toEqual(['archi']);
    office.assignCard('archi', c.id, 'designer');
    expect(office.handoffFor(office.getCard(c.id))?.to).toEqual(['designer']);
  });

  it('keeps the old flow when the team has no designer', () => {
    const { office } = makeOffice();
    const c = office.createCard('lead', { title: 'Sans designer', column: 'TODO' });
    expect(office.moveCard('dev1', c.id, 'IN PROGRESS').col).toBe('IN_PROGRESS');
  });

  it('only lets the UI post plain notes', () => {
    const { office } = makeOffice(withDesigner());
    const c = office.createCard('lead', { title: 'x', column: 'TODO' });
    expect(() => office.commentCard('user', c.id, 'ok', 'review')).toThrow();
  });
});

describe('settings', () => {
  const setup = () => {
    const cfg = withDesigner();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-settings-'));
    const file = path.join(dir, 'office.config.json');
    fs.writeFileSync(file, JSON.stringify({ ...cfg, team: { repoPath: '../team', leadAgent: 'lead' } }, null, 2));
    const app = makeOffice(cfg);
    return { ...app, file, settings: new Settings(app.office, { configFile: file, setupScript: null }) };
  };

  it('changes a model and shares, saved to the file and applied at once', async () => {
    const { office, settings, file } = setup();
    const res = await settings.update({ agents: [{ name: 'dev1', model: 'claude-opus-5-5', share: 20 }, { name: 'dev2', share: 25 }] });
    expect(res.modelsChanged).toEqual(['dev1']);
    expect(res.sharesChanged).toBe(true);
    expect(office.shares().dev1).toBe(20);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(saved.agents.find((a: { name: string }) => a.name === 'dev1').model).toBe('claude-opus-5-5');
    expect(saved.team.repoPath).toBe('../team');
  });

  it('refuses shares that do not add up to 100, and a cap above 90 %', async () => {
    const { settings } = setup();
    await expect(settings.update({ agents: [{ name: 'dev1', share: 40 }] })).rejects.toThrow(/100/);
    await expect(settings.update({ quota: { hardCapPct: 95 } })).rejects.toThrow();
  });
});
