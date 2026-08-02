#!/usr/bin/env node
/**
 * Validates skills/ for agent-skill spec compliance and content drift:
 *  1. SKILL.md frontmatter: name == folder, kebab-case, description 1..1024 chars,
 *     single-line JSON metadata (OpenClaw fallback-parser requirement).
 *  2. SKILL.md stays within the 500-line spec guideline.
 *  3. Every references/ or scripts/ path mentioned in skill markdown exists.
 *  4. SDK version pins in reference packs and scripts/package.json match the
 *     versions declared in studio/package.json (drift gate).
 *  5. references/configs/*.jsonc are identical to studio/config/*.jsonc.
 */
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(new URL('.', import.meta.url).pathname, '../..');
const skillsDir = path.join(repoRoot, 'skills');
let failures = 0;

const fail = (msg) => { failures++; console.error(`FAIL  ${msg}`); };
const ok = (msg) => console.log(`ok    ${msg}`);

const studioPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'studio/package.json'), 'utf-8')
);
const studioVersions = Object.fromEntries(
  Object.entries(studioPkg.dependencies ?? {}).map(([k, v]) => [k, v.replace(/^[\^~]/, '')])
);

const skillDirs = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'evals')
  .map((d) => d.name);

for (const dir of skillDirs) {
  const skillPath = path.join(skillsDir, dir);
  const skillMd = path.join(skillPath, 'SKILL.md');
  if (!fs.existsSync(skillMd)) { fail(`${dir}: missing SKILL.md`); continue; }
  const raw = fs.readFileSync(skillMd, 'utf-8');
  const lines = raw.split('\n');

  // 1. frontmatter
  if (lines[0] !== '---') fail(`${dir}: SKILL.md must start with '---' frontmatter`);
  const end = lines.indexOf('---', 1);
  if (end === -1) { fail(`${dir}: unterminated frontmatter`); continue; }
  const fm = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2];
  }
  const name = (fm.name ?? '').trim();
  if (name !== dir) fail(`${dir}: frontmatter name '${name}' != folder name`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) fail(`${dir}: name must be kebab-case [a-z0-9-]`);
  const desc = (fm.description ?? '').replace(/^"|"$/g, '');
  if (desc.length < 1 || desc.length > 1024) fail(`${dir}: description must be 1..1024 chars (${desc.length})`);
  if (fm.metadata) {
    try { JSON.parse(fm.metadata); ok(`${dir}: metadata is single-line JSON`); }
    catch { fail(`${dir}: metadata must be a single-line JSON object (OpenClaw parser)`); }
  }

  // 2. size guideline
  if (lines.length > 500) fail(`${dir}: SKILL.md is ${lines.length} lines (spec guideline: <= 500)`);
  else ok(`${dir}: SKILL.md ${lines.length} lines`);

  // 3. referenced paths exist
  const mdFiles = [skillMd];
  const refDir = path.join(skillPath, 'references');
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir)) if (f.endsWith('.md')) mdFiles.push(path.join(refDir, f));
  }
  const pathRe = /(?:\.\.\/)?(?:references|scripts|configs)\/[A-Za-z0-9_./-]+/g;
  for (const file of mdFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    const fileDir = path.dirname(file);
    const insideReferences = fileDir.endsWith(`${path.sep}references`);
    for (const ref of content.match(pathRe) ?? []) {
      const clean = ref.replace(/[.,)]+$/, '');
      if (clean.includes('*')) continue;
      // Paths must resolve from the mentioning file's own directory (fall back to the
      // skill root only for SKILL.md-style root-relative mentions).
      const fromFile = fs.existsSync(path.resolve(fileDir, clean));
      const fromRoot = !clean.startsWith('../') && fs.existsSync(path.join(skillPath, clean));
      if (insideReferences && clean.startsWith('references/')) {
        fail(`${path.relative(repoRoot, file)}: '${clean}' is self-prefixed — use the sibling path ('${clean.slice('references/'.length)}')`);
      } else if (!fromFile && !fromRoot) {
        fail(`${path.relative(repoRoot, file)}: broken reference '${clean}'`);
      }
    }
  }

  // 4. version-pin drift vs studio/package.json
  const pinRe = /@meteora-ag\/([a-z0-9-]+)@(\d+\.\d+\.\d+)/g;
  for (const file of mdFiles) {
    const content = fs.readFileSync(file, 'utf-8');
    for (const m of content.matchAll(pinRe)) {
      const pkg = `@meteora-ag/${m[1]}`;
      const pinned = m[2];
      const studio = studioVersions[pkg];
      if (studio && studio !== pinned) {
        fail(`${path.relative(repoRoot, file)}: pins ${pkg}@${pinned} but studio declares ${studio} — update the reference pack`);
      }
    }
  }
  const scriptsPkgPath = path.join(skillPath, 'scripts/package.json');
  if (fs.existsSync(scriptsPkgPath)) {
    const scriptsPkg = JSON.parse(fs.readFileSync(scriptsPkgPath, 'utf-8'));
    for (const [pkg, v] of Object.entries(scriptsPkg.dependencies ?? {})) {
      if (pkg.startsWith('@meteora-ag/') && studioVersions[pkg] && studioVersions[pkg] !== v) {
        fail(`skills/${dir}/scripts/package.json: ${pkg}@${v} != studio ${studioVersions[pkg]}`);
      }
    }
  }

  // 5. config template drift
  const cfgDir = path.join(skillPath, 'references/configs');
  if (fs.existsSync(cfgDir)) {
    for (const f of fs.readdirSync(cfgDir)) {
      const studioCfg = path.join(repoRoot, 'studio/config', f);
      if (!fs.existsSync(studioCfg)) { fail(`${dir}: configs/${f} has no studio/config counterpart`); continue; }
      if (fs.readFileSync(path.join(cfgDir, f), 'utf-8') !== fs.readFileSync(studioCfg, 'utf-8')) {
        fail(`${dir}: configs/${f} differs from studio/config/${f} — re-copy it`);
      }
    }
    ok(`${dir}: config templates checked against studio/config`);
  }
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll skill validations passed.');
