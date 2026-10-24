/**
 * Admin CLI for setups without the app (servers, scripts, first event).
 *   node dist/seed-cli.js signup <email> <name> <password> "<org name>"   account + organisation (owner)
 *   node dist/seed-cli.js member <org-id> <email> <role> [name] [password] add staff (owner|director|scorer|commentator|camera)
 *   node dist/seed-cli.js tournament <org-id> "<name>" [venue] [laptop|cloud]
 *   node dist/seed-cli.js joincode <tournament-id> <camera|scorer|commentator> [label]
 *   node dist/seed-cli.js orgs                                             list organisations
 */
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { Repo } from './repo.js';
import { ORG_ROLES, GUEST_ROLES, hashPassword, type OrgRole, type GuestRole } from './auth.js';

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);
  await migrate(db);
  const repo = new Repo(db);
  try {
    switch (cmd) {
      case 'signup': {
        const [email, name, password, orgName] = args;
        if (!email || !name || !password || password.length < 8 || !orgName) throw new Error('usage: signup <email> <name> <password(8+)> "<org name>"');
        if (await repo.userByEmail(email)) throw new Error(`user ${email} already exists`);
        const passwordHash = await hashPassword(password);
        const { u, o } = await repo.tx(async (c) => {
          const u = await repo.createUser({ email, name, passwordHash }, c);
          const o = await repo.createOrg(orgName, c);
          await repo.addMember(o.id, u.id, 'owner', c);
          return { u, o };
        });
        console.log(`created ${u.email} (owner) in org "${o.name}" ${o.id}`);
        break;
      }
      case 'member': {
        const [orgId, email, role, name, password] = args;
        if (!orgId || !email || !ORG_ROLES.includes(role as OrgRole)) throw new Error(`usage: member <org-id> <email> <${ORG_ROLES.join('|')}> [name] [password]`);
        let u = await repo.userByEmail(email);
        if (!u) {
          if (!name || !password || password.length < 8) throw new Error('new user: give name and password (8+)');
          u = await repo.createUser({ email, name, passwordHash: await hashPassword(password) });
        }
        await repo.addMember(orgId, u.id, role as OrgRole);
        console.log(`${u.email} is now ${role} in ${orgId}`);
        break;
      }
      case 'tournament': {
        const [orgId, name, venue, mode] = args;
        if (!orgId || !name) throw new Error('usage: tournament <org-id> "<name>" [venue] [laptop|cloud]');
        const t = await repo.createTournament({ orgId, name, venue: venue ?? null, mode: mode === 'cloud' ? 'cloud' : 'laptop' });
        console.log(`created tournament "${t.name}" ${t.id} (${t.production_mode})\nengine key: ${t.engine_key}`);
        break;
      }
      case 'joincode': {
        const [tid, role, label] = args;
        if (!tid || !GUEST_ROLES.includes(role as GuestRole)) throw new Error(`usage: joincode <tournament-id> <${GUEST_ROLES.join('|')}> [label]`);
        const c = await repo.createJoinCode(tid, role as GuestRole, label ?? null, null, null);
        console.log(`${c.code}  ${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/join/${c.code}`);
        break;
      }
      case 'orgs': {
        const r = await db.query<{ id: string; name: string }>('SELECT id, name FROM orgs ORDER BY created_at');
        for (const o of r.rows) console.log(`${o.id}  ${o.name}`);
        break;
      }
      default:
        throw new Error('commands: signup, member, tournament, joincode, orgs');
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
