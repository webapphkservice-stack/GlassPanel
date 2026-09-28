#!/usr/bin/env bash
set -e
cd /opt/glass-panel
for f in server/services/nginxService.js server/config/default.js server/app.js server/services/commandRunner.js server/scripts/createAdmin.js server/bin/www.js; do
  node --check "$f" || { echo "SYNTAX_FAIL $f"; exit 1; }
done
echo SYNTAX_OK

NEW=$(grep -o "index-[A-Za-z0-9_-]*\.js" client/dist/index.html | head -1)
NEWCSS=$(grep -o "index-[A-Za-z0-9_-]*\.css" client/dist/index.html | head -1)
for f in client/dist/assets/index-*.js; do b=$(basename "$f"); [ "$b" != "$NEW" ] && rm -f "$f"; done
for f in client/dist/assets/index-*.css; do b=$(basename "$f"); [ "$b" != "$NEWCSS" ] && rm -f "$f"; done

echo "SERVICE=$(systemctl is-active glass-panel)"
echo "HTTP=$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3399/)"
echo "DIST_REF=$NEW"
echo "JS_FETCH=$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:3399/assets/$NEW)"

echo "===== PATH SECURITY TEST ====="
cat > /tmp/sec-path.cjs <<'JSEOF'
const svc = require("/opt/glass-panel/server/services/nginxService");
const fs = require("fs");
const assert = (c,m)=>{ if(!c) throw new Error("FAIL: "+m); console.log("PASS: "+m); };
const testDir = "/etc/nginx/conf.d/.p2-test";
const outside = "/tmp/p2-test-secret";
fs.rmSync(testDir,{recursive:true,force:true});
fs.rmSync(outside,{recursive:true,force:true});
fs.mkdirSync(testDir,{recursive:true});
fs.mkdirSync(outside,{recursive:true});
fs.writeFileSync(outside + "/passwd", "leak", "utf8");
fs.symlinkSync(outside + "/passwd", testDir + "/passwd.conf");
(async () => {
  let hit=false;
  try { await svc.readConfig(testDir + "/passwd.conf"); } catch (e) { hit = true; }
  assert(hit, "符号链接指向允许目录外被拒绝");
  hit=false;
  try { await svc.readConfig(testDir + "/../../tmp/p2-test-secret/passwd"); } catch (e) { hit = true; }
  assert(hit, "../ 越界路径被拒绝");
  fs.writeFileSync(testDir + "/app.conf", "server {}", "utf8");
  const ok = await svc.readConfig(testDir + "/app.conf");
  assert(ok === "server {}", "允许目录内文件正常读取");
  hit=false;
  try { await svc.writeConfig(testDir + "/../app.conf", "x"); } catch (e) { hit = true; }
  assert(hit, "writeConfig 父目录越界被拒绝");
  fs.rmSync(testDir,{recursive:true,force:true});
  fs.rmSync(outside,{recursive:true,force:true});
  console.log("PATH_ASSERT_OK");
})();
JSEOF
node /tmp/sec-path.cjs
rm -f /tmp/sec-path.cjs

echo "===== DEFAULT CREDS POLICY TEST ====="
cat > /tmp/sec-default.cjs <<'JSEOF'
const path = require("path");
const cp = require("child_process");
function loadConfig(env) {
  const script = "require('" + path.join('/opt/glass-panel/server/config','default.js').replace(/\\/g,'/') + "'); console.log('LOADED')";
  return cp.execSync("node -e " + JSON.stringify(script), {
    encoding: "utf8",
    env: { ...process.env, ...env },
    cwd: "/opt/glass-panel/server",
  });
}
const badCases = [
  ["PROD_NO_SECRET", { NODE_ENV: "production", JWT_SECRET: "", DEFAULT_ADMIN_USERNAME: "admin", DEFAULT_ADMIN_PASSWORD: "StrongPass123" }],
  ["PROD_WEAK_SECRET", { NODE_ENV: "production", JWT_SECRET: "default-change-me", DEFAULT_ADMIN_USERNAME: "admin", DEFAULT_ADMIN_PASSWORD: "StrongPass123" }],
  ["PROD_DEFAULT_CREDS", { NODE_ENV: "production", JWT_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", DEFAULT_ADMIN_USERNAME: "admin", DEFAULT_ADMIN_PASSWORD: "admin123" }],
  ["PROD_SHORT_PASS", { NODE_ENV: "production", JWT_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", DEFAULT_ADMIN_USERNAME: "admin", DEFAULT_ADMIN_PASSWORD: "123" }],
];
for (const [label, env] of badCases) {
  try { loadConfig(env); console.log("FAIL " + label + " should reject"); }
  catch (e) { console.log("PASS " + label + " rejected: " + e.message.split("\n")[0]); }
}
try {
  loadConfig({ NODE_ENV: "production", JWT_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", DEFAULT_ADMIN_USERNAME: "admin", DEFAULT_ADMIN_PASSWORD: "StrongPass123" });
  console.log("PASS PROD_OK accepted");
} catch (e) { console.log("FAIL PROD_OK should accept: " + e.message); }
JSEOF
node /tmp/sec-default.cjs
rm -f /tmp/sec-default.cjs

echo "===== LOGIN RATE LIMIT TEST ====="
cat > /tmp/sec-limit.cjs <<'JSEOF'
const http = require("http");
function login(u) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ username: u, password: "wrong" });
    const req = http.request({ hostname: "127.0.0.1", port: 3399, path: "/api/auth/login", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", () => resolve({ status: 0 }));
    req.write(data);
    req.end();
  });
}
(async () => {
  const uniq = Date.now();
  const user = "ratelimit_" + uniq;
  const results = [];
  // 使用同一账号连续请求，验证 IP+账号 维度限流
  for (let i = 0; i < 12; i++) results.push(await login(user));
  const rateLimited = results.filter((r) => r.status === 429).length;
  const unauthorized = results.filter((r) => r.status === 401).length;
  console.log("RATE_LIMITED=" + rateLimited + " UNAUTHORIZED=" + unauthorized);
  console.log(rateLimited >= 1 ? "PASS login limiter triggered" : "FAIL no 429");
})();
JSEOF
node /tmp/sec-limit.cjs
rm -f /tmp/sec-limit.cjs

echo "===== SENSITIVE LOG SANITIZE TEST ====="
cat > /tmp/sec-log.cjs <<'JSEOF'
const { run } = require("/opt/glass-panel/server/services/commandRunner");
const chunks = [];
const originalWrite = process.stdout.write;
process.stdout.write = function(c) { chunks.push(String(c)); return true; };
(async () => {
  await run("mysql", ["-e", "CREATE USER IF NOT EXISTS 'u'@'localhost' IDENTIFIED BY 'supersecret123';"]);
  process.stdout.write = originalWrite;
  const out = chunks.join("");
  const hasPassword = out.includes("supersecret123");
  const sanitized = out.includes("IDENTIFIED BY") && out.includes("***");
  console.log("LOG_CONTAINS_PASSWORD=" + hasPassword);
  console.log("LOG_SANITIZED=" + sanitized);
  console.log(sanitized && !hasPassword ? "PASS password not in log" : "FAIL password leaked or not sanitized");
})();
JSEOF
node /tmp/sec-log.cjs
rm -f /tmp/sec-log.cjs

echo DRIVER_DONE
