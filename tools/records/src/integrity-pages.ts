import {
  BACKGROUND,
  COMPONENTS,
  FLOWS,
  PRINCIPLES,
  QUALITY,
  SERVICES,
  SETTINGS,
  SUMMARY,
  WORKFLOWS,
} from './architecture.ts';
import { DOMAINS, FUNCTIONS, ROLES, RULES, TABLES } from './data-model.ts';
import { githubWorkflows, settingsRead, workspacePackages } from './inventory.ts';
import { workflowIds } from './repo.ts';
import { schemaSnapshot, snapshotObjectNames } from './schema.ts';

type Fail = (where: string, what: string) => void;
type CheckText = (where: string, text: string | undefined) => void;

/**
 * The architecture and data model pages describe everything the repository holds, and nothing
 * it doesn't. A component, setting, workflow, background function, table or database function
 * that arrives without a description fails here, in `pnpm test`.
 */
export function pageProblems(fail: Fail, checkText: CheckText, known: (id: string) => boolean) {
  // A reference must be a record id, an ADR or a backlog item, and must exist.
  const refs = (where: string, ids: readonly string[]) => {
    ids.forEach((r) => known(r) || fail(where, `${r} is not a record id`));
    checkText(where, ids.join(' '));
  };
  // Architecture: components cover the workspace exactly.
  const named = new Map<string, string>();
  for (const c of COMPONENTS) {
    for (const path of c.where) {
      if (named.has(path))
        fail('architecture', `${path} is named by ${named.get(path)} and ${c.name}`);
      named.set(path, c.name);
    }
    checkText(`architecture ${c.name}`, c.responsibility);
  }
  const packages = workspacePackages().map((p) => p.path);
  for (const path of packages) {
    if (!named.has(path)) fail('architecture', `workspace package ${path} has no component`);
  }
  for (const path of named.keys()) {
    if (!packages.includes(path)) fail('architecture', `${path} is not a workspace package`);
  }

  // Every setting read is described once, and nothing described is unread.
  const read = settingsRead();
  const described = new Map<string, number>();
  for (const s of SETTINGS) {
    for (const name of s.names) described.set(name, (described.get(name) ?? 0) + 1);
    checkText(`setting ${s.names.join(', ')}`, s.use);
  }
  for (const [name, files] of read) {
    if (!described.has(name))
      fail('architecture', `${name} is read (${files[0]}) but not described`);
  }
  for (const [name, count] of described) {
    if (count > 1) fail('architecture', `${name} is described twice`);
    if (!read.has(name)) fail('architecture', `${name} is described but nothing reads it`);
  }

  // GitHub workflows and background functions.
  const workflowFiles = githubWorkflows().map((w) => w.file);
  for (const file of workflowFiles) {
    if (!WORKFLOWS[file]) fail('architecture', `.github/workflows/${file} is not described`);
  }
  for (const file of Object.keys(WORKFLOWS)) {
    if (!workflowFiles.includes(file)) fail('architecture', `workflow ${file} doesn't exist`);
  }
  const functions = workflowIds();
  for (const id of functions) {
    if (!BACKGROUND[id]) fail('architecture', `background function ${id} is not described`);
  }
  for (const id of Object.keys(BACKGROUND)) {
    if (!functions.includes(id)) fail('architecture', `background function ${id} doesn't exist`);
  }

  // Every reference resolves.
  checkText('architecture summary', SUMMARY);
  for (const p of PRINCIPLES) {
    checkText(`principle ${p.id}`, `${p.built} ${p.short ?? ''}`);
    refs(`principle ${p.id}`, p.refs);
  }
  for (const f of FLOWS) {
    checkText(`flow ${f.id}`, f.about);
    refs(`flow ${f.id}`, f.refs);
  }
  for (const q of QUALITY) {
    checkText(`quality ${q.attribute}`, `${q.how} ${q.short}`);
    refs(`quality ${q.attribute}`, q.refs);
  }
  SERVICES.forEach((s) => checkText(`service ${s.name}`, s.role));

  // Data model: every table in one domain with a description; every function and role described.
  const snapshot = schemaSnapshot();
  const tables = snapshot.tables.map((t) => t.name);
  const domainOf = new Map<string, string>();
  for (const d of DOMAINS) {
    checkText(`domain ${d.name}`, d.about);
    for (const t of d.tables) {
      if (domainOf.has(t)) fail('data model', `${t} is in ${domainOf.get(t)} and ${d.name}`);
      domainOf.set(t, d.name);
      if (!tables.includes(t))
        fail('data model', `domain ${d.name} names ${t}, which doesn't exist`);
    }
  }
  for (const t of tables) {
    if (!domainOf.has(t)) fail('data model', `table ${t} is in no domain`);
    if (!TABLES[t]) fail('data model', `table ${t} has no description`);
  }
  for (const [t, note] of Object.entries(TABLES)) {
    if (!tables.includes(t)) fail('data model', `${t} is described but doesn't exist`);
    checkText(`table ${t}`, `${note.about} ${note.writtenBy ?? ''}`);
  }
  const functionNames = snapshot.functions.map((f) => f.name);
  for (const f of functionNames) {
    if (!FUNCTIONS[f]) fail('data model', `function ${f} has no description`);
  }
  for (const [f, about] of Object.entries(FUNCTIONS)) {
    if (!functionNames.includes(f)) fail('data model', `function ${f} doesn't exist`);
    checkText(`function ${f}`, about);
  }
  const grantees = new Set(snapshot.tables.flatMap((t) => Object.keys(t.grants)));
  snapshot.roles.forEach((r) => grantees.add(r.name));
  for (const role of grantees) {
    if (!ROLES[role]) fail('data model', `role ${role} has no description`);
  }
  for (const [role, about] of Object.entries(ROLES)) checkText(`role ${role}`, about);

  // Each rule names objects the schema has.
  const objects = snapshotObjectNames(snapshot);
  for (const rule of RULES) {
    checkText(`rule "${rule.rule}"`, `${rule.rule} ${rule.mechanism}`);
    for (const o of rule.objects) {
      if (!objects.has(o)) fail(`rule "${rule.rule}"`, `${o} is not in the schema`);
    }
    refs(`rule "${rule.rule}"`, rule.refs);
  }
}
