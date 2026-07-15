// Spot curation tool — LOCAL ONLY, never deployed. Single-file Hono server that
// serves an inline Leaflet page and reads/writes watersport_spot on the prod DB.
//
//   npx tsx --env-file=.env tools/spot-curator.ts   →  http://localhost:5678
//
// Workflow: bulk-approve the auto-confident spots (they already have a
// shoreBearing), then hand-review the flagged ones on a map — click the water to
// set the shore-facing direction, confirm sports/waterType, Approve/Reject/Skip.
// DB creds come from process.env.DATABASE_URL (--env-file), never read in code.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Hono } from "hono";
import pg from "pg";
import { spotTable } from "../src/db/schema";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const app = new Hono();

// Per-spot context from the cleaned harvest JSON (real Google name, deep-link,
// rating, member count, confidence), keyed by the same coordinate the loader
// used so it joins to the DB rows. Loaded once at startup.
const SS = join(dirname(fileURLToPath(import.meta.url)), "../spot-sourcing");
const geoKey = (lat: number, lng: number) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
const extra = new Map<string, Record<string, unknown>>();
try {
  // Rich fields (real name, Google deep-link, rating, members) live in harvest/.
  for (const f of readdirSync(join(SS, "harvest")).filter((x) => x.endsWith(".json") && x !== "state.json")) {
    const d = JSON.parse(readFileSync(join(SS, "harvest", f), "utf8"));
    for (const s of d.spots ?? []) {
      const loc = s.beach?.location ?? s.centroid;
      if (!loc || typeof loc.latitude !== "number") continue;
      extra.set(geoKey(loc.latitude, loc.longitude), {
        _lat: loc.latitude,
        _lng: loc.longitude,
        origLabel: s.label ?? null,
        googleMapsUri: s.googleMapsUri ?? null,
        rating: s.topRating ?? null,
        reviews: s.topReviews ?? null,
        members: s.memberCount ?? null,
        beachName: s.beach?.name ?? null,
      });
    }
  }
  // confidence lives in cleaned/ — merge onto the same coordinate key.
  for (const f of readdirSync(join(SS, "cleaned")).filter((x) => x.endsWith(".clean.json"))) {
    const d = JSON.parse(readFileSync(join(SS, "cleaned", f), "utf8"));
    for (const s of d.kept) {
      const loc = s.beach?.location ?? s.coord;
      if (!loc || typeof loc.latitude !== "number") continue;
      const k = geoKey(loc.latitude, loc.longitude);
      extra.set(k, { ...(extra.get(k) ?? {}), confidence: s.confidence ?? null });
    }
  }
  console.log(`Loaded context for ${extra.size} spots`);
} catch (e) {
  console.warn("spot-sourcing context not loaded:", (e as Error).message);
}

// Relocated spots (water-snap) no longer match by exact coord, so fall back to
// the nearest harvest context within ~2.6km (max relocation distance).
const extraArr = [...extra.values()];
function nearestCtx(lat: number, lng: number) {
  const tr = (x: number) => (x * Math.PI) / 180;
  let best: Record<string, unknown> | null = null;
  let bd = 2600;
  for (const e of extraArr) {
    const dLat = tr((e._lat as number) - lat), dLon = tr((e._lng as number) - lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(tr(lat)) * Math.cos(tr(e._lat as number)) * Math.sin(dLon / 2) ** 2;
    const d = 2 * 6371000 * Math.asin(Math.sqrt(s));
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

app.get("/api/stats", async (c) => {
  const rows = await db
    .select({ status: spotTable.status, n: sql<number>`count(*)::int` })
    .from(spotTable)
    .groupBy(spotTable.status);
  const flagged = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spotTable)
    .where(and(eq(spotTable.status, "pending"), isNull(spotTable.shoreBearingDeg)));
  const out: Record<string, number> = { published: 0, pending: 0, rejected: 0 };
  for (const r of rows) out[r.status] = r.n;
  return c.json({ ...out, pendingFlagged: flagged[0].n });
});

// Pending spots needing manual direction (no shoreBearing), flagged-first.
app.get("/api/spots", async (c) => {
  const filter = c.req.query("filter") ?? "flagged";
  const where =
    filter === "flagged"
      ? and(eq(spotTable.status, "pending"), isNull(spotTable.shoreBearingDeg))
      : eq(spotTable.status, "pending");
  const spots = await db
    .select({
      uid: spotTable.uid,
      name: spotTable.name,
      country: spotTable.country,
      latitude: spotTable.latitude,
      longitude: spotTable.longitude,
      waterType: spotTable.waterType,
      supportedSports: spotTable.supportedSports,
      shoreBearingDeg: spotTable.shoreBearingDeg,
      onWater: spotTable.onWater,
      placeTypes: spotTable.placeTypes,
    })
    .from(spotTable)
    .where(where)
    .orderBy(asc(spotTable.country), asc(spotTable.name))
    .limit(2000);
  const enriched = spots.map((s) => ({
    ...s,
    ...(extra.get(geoKey(s.latitude, s.longitude)) ?? nearestCtx(s.latitude, s.longitude) ?? {}),
  }));
  return c.json({ spots: enriched });
});

app.post("/api/spots/:uid", async (c) => {
  const uid = c.req.param("uid");
  const b = await c.req.json();
  const set: Record<string, unknown> = {};
  if (b.shoreBearingDeg === null || typeof b.shoreBearingDeg === "number") set.shoreBearingDeg = b.shoreBearingDeg;
  if (Array.isArray(b.supportedSports)) set.supportedSports = b.supportedSports;
  if (Array.isArray(b.placeTypes)) set.placeTypes = b.placeTypes;
  if (typeof b.onWater === "boolean") set.onWater = b.onWater;
  if (typeof b.latitude === "number") set.latitude = b.latitude;
  if (typeof b.longitude === "number") set.longitude = b.longitude;
  if (b.waterType === null || typeof b.waterType === "string") set.waterType = b.waterType;
  if (b.status === "published" || b.status === "rejected" || b.status === "pending")
    set.status = b.status;
  if (Object.keys(set).length === 0) return c.json({ ok: false, error: "no fields" }, 400);
  await db.update(spotTable).set(set).where(eq(spotTable.uid, uid));
  return c.json({ ok: true });
});

// Publish every pending spot that already has a shoreBearing (the confident set).
app.post("/api/bulk-approve-confident", async (c) => {
  const res = await db
    .update(spotTable)
    .set({ status: "published" })
    .where(and(eq(spotTable.status, "pending"), sql`${spotTable.shoreBearingDeg} is not null`))
    .returning({ uid: spotTable.uid });
  return c.json({ approved: res.length });
});

app.get("/", (c) => c.html(HTML));

serve({ fetch: app.fetch, port: 5678 }, (i) =>
  console.log(`Spot curator → http://localhost:${i.port}`),
);

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spot Curator</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  *{box-sizing:border-box} body{margin:0;font:14px/1.4 system-ui,sans-serif;display:flex;height:100vh}
  #map{flex:1}
  #panel{width:340px;padding:16px;overflow:auto;background:#0f172a;color:#e2e8f0}
  h2{margin:.2em 0;font-size:16px} .muted{color:#94a3b8;font-size:12px}
  .row{margin:12px 0} .chip{display:inline-block;padding:3px 9px;margin:2px;border-radius:12px;background:#1e293b;cursor:pointer;user-select:none;border:1px solid #334155}
  .chip.on{background:#2563eb;border-color:#3b82f6}
  select,button{font:inherit;padding:7px 10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0}
  button{cursor:pointer} button.primary{background:#16a34a;border-color:#22c55e} button.danger{background:#b91c1c;border-color:#ef4444}
  button:disabled{opacity:.4;cursor:default}
  .verdict{font-size:12px;margin-top:6px} .good{color:#34d399} .risky{color:#f87171}
  .bar{display:flex;gap:8px;margin-top:10px} .bar button{flex:1}
  code{background:#1e293b;padding:1px 5px;border-radius:4px}
</style></head><body>
<div id="map"></div>
<div id="panel">
  <div class="muted" id="stats">yükleniyor…</div>
  <div class="row"><button id="bulk" class="primary">⚡ Güvenlileri toplu onayla</button></div>
  <hr style="border-color:#1e293b">
  <h2 id="name">—</h2>
  <div class="muted" id="orig"></div>
  <div class="muted" id="meta"></div>
  <div class="row" style="display:flex;gap:6px">
    <a id="gspot" href="#" target="_blank" rel="noopener" style="flex:1;text-decoration:none"><button style="width:100%">📍 Spot noktası</button></a>
    <a id="gbiz" href="#" target="_blank" rel="noopener" style="flex:1;text-decoration:none"><button style="width:100%">🏫 Kaynak (Google)</button></a>
  </div>
  <div class="muted" id="loc">—</div>
  <div id="onwater" class="muted"></div>
  <div class="row">
    <div class="muted">Sporlar</div>
    <div id="sports"></div>
  </div>
  <div class="row">
    <div class="muted">Yer türü (tag)</div>
    <div id="ptypes"></div>
  </div>
  <div class="row">
    <div class="muted">Su tipi</div>
    <select id="water">
      <option value="">—</option><option>sea</option><option>open_coast</option>
      <option>bay</option><option>lake</option><option>river</option><option>marina</option>
    </select>
  </div>
  <div class="row" id="dirrow">
    <div class="muted">Kıyı yönü <span id="dirnote"></span> · mod:
      <label><input type="radio" name="mode" value="bearing" checked> yön ver</label>
      <label><input type="radio" name="mode" value="move"> pini taşı</label></div>
    <div id="bearing">yön yok</div>
    <div class="verdict" id="verdict"></div>
  </div>
  <div class="bar">
    <button class="primary" id="approve">✔ Onayla</button>
    <button id="skip">↷ Atla</button>
    <button class="danger" id="reject">✕ Sil</button>
  </div>
  <div class="muted" id="nearby" style="margin-top:12px"></div>
  <div class="muted" style="margin-top:12px">Kalan flagged: <span id="left">—</span></div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var SPORTS=["windsurf","kitesurf","wingfoil","sup","sailing","surfing"];
var PLACE_TYPES=["public_spot","school","rental","club","center","marina","accommodation","shop"];
var moved=false;
var COMPASS={N:0,NE:45,E:90,SE:135,S:180,SW:225,W:270,NW:315};
function toRad(d){return d*Math.PI/180} function toDeg(r){return r*180/Math.PI}
function bearing(a,b){var p1=toRad(a.lat),p2=toRad(b.lat),dl=toRad(b.lng-a.lng);
  var y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return (toDeg(Math.atan2(y,x))+360)%360}
function dest(lat,lng,brg,dm){var R=6371000,D=dm/R,t=toRad(brg),p1=toRad(lat),l1=toRad(lng);
  var p2=Math.asin(Math.sin(p1)*Math.cos(D)+Math.cos(p1)*Math.sin(D)*Math.cos(t));
  var l2=l1+Math.atan2(Math.sin(t)*Math.sin(D)*Math.cos(p1),Math.cos(D)-Math.sin(p1)*Math.sin(p2));
  return [toDeg(p2),toDeg(l2)]}
function classify(w,s){var d=Math.abs(((w-s+540)%360)-180);return d<45?"onshore":d>135?"offshore":"side"}
function isSpot(){return collectPlaceTypes().indexOf("public_spot")>=0;}
function updateDirUI(){var row=document.getElementById("dirrow"),note=document.getElementById("dirnote");
  if(isSpot()){row.style.opacity="1";note.textContent="";}
  else{row.style.opacity="0.4";note.textContent="(okul/servis — gerekmez)";}}

var osm=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:"© OpenStreetMap",maxZoom:19});
var sat=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{attribution:"Esri",maxZoom:19});
var map=L.map("map",{layers:[sat]}).setView([38.25,26.38],13);
L.control.layers({"Uydu":sat,"Harita":osm}).addTo(map);
var marker=null,arrow=null,seaEnd=null,nearbyLayer=L.layerGroup().addTo(map);

var queue=[],i=0,cur=null,curBearing=null;

function fmt(n){return n==null?"—":Math.round(n)+"°"}
async function refreshStats(){var s=await (await fetch("/api/stats")).json();
  document.getElementById("stats").innerHTML="published <b>"+s.published+"</b> · pending <b>"+s.pending+"</b> · rejected <b>"+s.rejected+"</b> · flagged <b>"+s.pendingFlagged+"</b>";}
async function load(){await refreshStats();
  var r=await (await fetch("/api/spots?filter=flagged")).json();queue=r.spots;i=0;show();}
function show(){
  if(i>=queue.length){document.getElementById("name").textContent="🎉 flagged bitti";document.getElementById("loc").textContent="";document.getElementById("left").textContent=0;return;}
  cur=queue[i];curBearing=cur.shoreBearingDeg;
  document.getElementById("name").textContent=cur.name;
  document.getElementById("orig").textContent=(cur.origLabel&&cur.origLabel!==cur.name)?("Google: "+cur.origLabel):"";
  var meta=[];if(cur.rating!=null)meta.push("★"+cur.rating+" ("+(cur.reviews||0)+" yorum)");if(cur.members)meta.push(cur.members+" işletme");if(cur.confidence)meta.push("güven: "+cur.confidence);if(cur.beachName)meta.push("plaj: "+cur.beachName);
  document.getElementById("meta").innerHTML=meta.join(" · ");
  document.getElementById("gspot").href="https://www.google.com/maps/search/?api=1&query="+cur.latitude+","+cur.longitude;
  var gb=document.getElementById("gbiz");if(cur.googleMapsUri){gb.href=cur.googleMapsUri;gb.style.display="";}else{gb.style.display="none";}
  document.getElementById("loc").textContent=(cur.country||"")+" · "+cur.latitude.toFixed(4)+", "+cur.longitude.toFixed(4);
  document.getElementById("left").textContent=queue.length-i;
  document.getElementById("water").value=cur.waterType||"";
  var sc=document.getElementById("sports");sc.innerHTML="";
  SPORTS.forEach(function(sp){var el=document.createElement("span");el.className="chip"+((cur.supportedSports||[]).indexOf(sp)>=0?" on":"");el.textContent=sp;el.onclick=function(){el.classList.toggle("on")};sc.appendChild(el);});
  var pc=document.getElementById("ptypes");pc.innerHTML="";
  PLACE_TYPES.forEach(function(pt){var el=document.createElement("span");el.className="chip"+((cur.placeTypes||[]).indexOf(pt)>=0?" on":"");el.textContent=pt;el.onclick=function(){el.classList.toggle("on");updateDirUI();};pc.appendChild(el);});
  document.getElementById("onwater").innerHTML=cur.onWater===false?"<span class='risky'>⚠︎ onWater=false — içeride (okul ofisi?) → suya taşı ya da Sil</span>":(cur.onWater===true?"<span class='good'>onWater ✓</span>":"onWater: —");
  moved=false;updateDirUI();
  map.setView([cur.latitude,cur.longitude],14);
  if(marker)map.removeLayer(marker);
  marker=L.marker([cur.latitude,cur.longitude]).addTo(map);
  drawBearing();drawNearby();
}
function drawBearing(){
  if(arrow)map.removeLayer(arrow);if(seaEnd)map.removeLayer(seaEnd);
  var bEl=document.getElementById("bearing"),vEl=document.getElementById("verdict");
  if(curBearing==null){bEl.textContent="yön yok — suya tıkla";vEl.innerHTML="";return;}
  var e=dest(cur.latitude,cur.longitude,curBearing,1200);
  arrow=L.polyline([[cur.latitude,cur.longitude],e],{color:"#f59e0b",weight:4}).addTo(map);
  seaEnd=L.circleMarker(e,{radius:6,color:"#f59e0b",fillColor:"#f59e0b",fillOpacity:1}).addTo(map);
  bEl.innerHTML="shoreBearing <code>"+fmt(curBearing)+"</code>";
  var good=[],risky=[];Object.keys(COMPASS).forEach(function(d){var v=classify(COMPASS[d],curBearing);if(v==="side")good.push(d);if(v==="offshore")risky.push(d);});
  vEl.innerHTML="<span class='good'>iyi (side): "+good.join(",")+"</span> · <span class='risky'>riskli (off): "+risky.join(",")+"</span>";
}
function drawNearby(){nearbyLayer.clearLayers();var n=0;
  queue.forEach(function(s){if(s.uid===cur.uid)return;var dLat=(s.latitude-cur.latitude),dLng=(s.longitude-cur.longitude);
    var m=Math.sqrt(dLat*dLat+dLng*dLng)*111000;if(m<600){n++;L.circleMarker([s.latitude,s.longitude],{radius:5,color:"#64748b"}).bindTooltip(s.name).addTo(nearbyLayer);}});
  document.getElementById("nearby").innerHTML=n?("⚠︎ "+n+" olası tekrar &lt;600m (gri) — aynıysa Sil"):"";
}
map.on("click",function(e){if(!cur)return;
  var mode=document.querySelector("input[name=mode]:checked").value;
  if(mode==="move"){cur.latitude=e.latlng.lat;cur.longitude=e.latlng.lng;moved=true;
    if(marker)map.removeLayer(marker);marker=L.marker([cur.latitude,cur.longitude]).addTo(map);
    document.getElementById("loc").textContent=(cur.country||"")+" · "+cur.latitude.toFixed(4)+", "+cur.longitude.toFixed(4)+" (taşındı)";
    document.getElementById("onwater").innerHTML="<span class='good'>suya taşındı ✓</span>";drawBearing();drawNearby();}
  else{curBearing=bearing({lat:cur.latitude,lng:cur.longitude},e.latlng);drawBearing();}
});

function collectSports(){return Array.prototype.map.call(document.querySelectorAll("#sports .chip.on"),function(el){return el.textContent});}
function collectPlaceTypes(){return Array.prototype.map.call(document.querySelectorAll("#ptypes .chip.on"),function(el){return el.textContent});}
async function save(status){
  var body={status:status,supportedSports:collectSports(),placeTypes:collectPlaceTypes(),waterType:document.getElementById("water").value||null};
  if(isSpot())body.shoreBearingDeg=(curBearing!=null?curBearing:null); else body.shoreBearingDeg=null;
  if(moved){body.latitude=cur.latitude;body.longitude=cur.longitude;body.onWater=true;}
  await fetch("/api/spots/"+cur.uid,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  i++;show();refreshStats();
}
document.getElementById("approve").onclick=function(){save("published");};
document.getElementById("reject").onclick=function(){save("rejected");};
document.getElementById("skip").onclick=function(){i++;show();};
document.getElementById("bulk").onclick=async function(){if(!confirm("shoreBearing'i olan tüm pending spotları published yap?"))return;
  var r=await (await fetch("/api/bulk-approve-confident",{method:"POST"})).json();alert(r.approved+" spot onaylandı");refreshStats();};
load();
</script>
</body></html>`;
