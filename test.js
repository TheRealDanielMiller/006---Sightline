const { plan } = require("./engine.js");
const { SAMPLE_DATA: D } = require("./data.js");
const P = Object.fromEntries(D.places.map((p) => [p.id, p]));
const fmt = (a) => {
  if (a.type === "walk") return `walk ${a.side} ${a.from}->${a.to} gap=${a.gapM} closed=${a.closedM} adj=${a.adjM}`;
  if (a.type === "pass") return `pass ${a.I.id} on ${a.side} (no leg)`;
  if (a.type === "crossCross") return `crossCross ${a.I.id} leg ${a.leg} ${a.visible ? "VISIBLE" : a.ntor ? "NTOR" : "BLIND"} ${a.rightHook || ""} xw=${!a.noCrosswalk} corner=${a.corner.length}`;
  if (a.type === "crossCorridor") return `crossUS ${a.I.id} leg ${a.leg} ${a.from}->${a.to} ${a.visible ? "VISIBLE" : a.ntor ? "NTOR" : "BLIND"}`;
};
for (const [o, d, t, we] of [["home", "work", 450, false], ["work", "home", 1080, false], ["bus", "office", 480, false], ["grocery", "plaza", 600, false], ["home", "bus", 600, false], ["plaza", "grocery", 1300, false]]) {
  const r = plan(D, P[o], P[d], { minutes: t, weekend: we, dark: t < 405 || t > 1065 });
  console.log(`\n== ${o} -> ${d} @${t}`);
  console.log(" SAFE", JSON.stringify(r.safe.exposure));
  r.safe.acts.forEach((a) => console.log("   ", fmt(a)));
  console.log(" TYPICAL", JSON.stringify(r.typical.exposure));
  r.typical.acts.forEach((a) => console.log("   ", fmt(a)));
}
