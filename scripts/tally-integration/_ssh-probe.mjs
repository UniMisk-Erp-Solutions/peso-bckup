import { Client } from "ssh2";
const users = process.argv.slice(2);
const pass = process.env.DEPLOY_SSH_PASSWORD;
if (!pass) {
  console.error("DEPLOY_SSH_PASSWORD required");
  process.exit(2);
}
async function tryUser(user) {
  return new Promise((resolve) => {
    const c = new Client();
    c.on("ready", () => {
      c.end();
      resolve({ user, ok: true });
    }).on("error", (e) => resolve({ user, ok: false, err: e.message })).connect({
      host: "192.168.23.46",
      username: user,
      password: pass,
      readyTimeout: 10000,
    });
  });
}
for (const u of users) {
  const r = await tryUser(u);
  console.log(JSON.stringify(r));
}
