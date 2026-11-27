// HTTP 请求吞吐留存测试: 模拟 termx 被高频请求(hook POST + sessions GET + JSON)
const fs = require("fs");
const rss = () => +fs.readFileSync("/proc/self/status","utf8").match(/VmRSS:\s+(\d+)/)[1];
const app = new (require("hono").Hono)();
app.post("/hook/:s", (c) => c.json({ ok: true }));
app.get("/sessions", (c) => c.json([{ n: 1 }, { n: 2 }, { n: 3 }]));
app.get("/layout", (c) => c.json({ a: 1 }));
const server = Bun.serve({ port: 17780, fetch: app.fetch });
const r0 = rss();
let n = 0;
console.log("start rss:", r0);
// 本机全速打 30 秒(交替三种请求, 模拟真实流量形状)
const t0 = Date.now();
const timer = setInterval(() => {
  console.log("t="+((Date.now()-t0)/1000).toFixed(0)+"s reqs="+(n/1000).toFixed(0)+"k rss="+rss()+"KB (start "+r0+")");
  if (Date.now()-t0 > 30000) {
    clearInterval(timer);
    setTimeout(() => { console.log("FINAL reqs="+(n/1000).toFixed(1)+"k rss="+rss()+"KB delta="+((rss()-r0)/1024)+"MB"); server.stop(); process.exit(0); }, 2000);
  }
}, 5000);
(async () => {
  while (Date.now()-t0 < 30000) {
    await Promise.all([
      fetch("http://127.0.0.1:17780/hook/x", { method: "POST", body: JSON.stringify({ status: "running", message: "x" }) }),
      fetch("http://127.0.0.1:17780/sessions"),
      fetch("http://127.0.0.1:17780/layout"),
    ]);
    n += 3;
  }
})();
