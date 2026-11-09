import assert from "node:assert/strict";
import test from "node:test";
import { PushupCounter } from "../counter.mjs";

const ASPECT = 4 / 3;
const FRAME_MS = 50;
const UPPER_ARM = 0.13;
const FOREARM = 0.13;

// Corp văzut din lateral: mâna fixă pe sol, cotul la unghiul cerut.
function frame({ elbowAngle, shoulderDrop = null, hipSag = 0, torsoTilt = 0, visibility = 0.95 }) {
  const wrist = { x: 0.3, y: 0.8 };
  const rad = (elbowAngle * Math.PI) / 180;
  const height = Math.sqrt(
    UPPER_ARM ** 2 + FOREARM ** 2 - 2 * UPPER_ARM * FOREARM * Math.cos(rad),
  );
  const shoulderY = shoulderDrop === null ? wrist.y - height : 0.54 + shoulderDrop;
  const shoulder = { x: wrist.x, y: shoulderY };
  const elbow = {
    x: wrist.x - Math.sqrt(Math.max(UPPER_ARM ** 2 - (height / 2) ** 2, 0)),
    y: (wrist.y + shoulderY) / 2,
  };
  const foot = { x: 0.95, y: 0.8 };
  const hip = {
    x: (shoulder.x + foot.x) / 2,
    y: (shoulder.y + foot.y) / 2 + hipSag + torsoTilt,
  };
  if (torsoTilt) shoulder.y -= torsoTilt;

  const points = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0.1 }));
  const set = (index, p) => {
    points[index] = { x: p.x / ASPECT, y: p.y, visibility };
  };
  set(11, shoulder);
  set(13, elbow);
  set(15, wrist);
  set(23, hip);
  set(25, { x: (hip.x + foot.x) / 2, y: (hip.y + foot.y) / 2 });
  set(27, foot);
  return points;
}

function feed(counter, frames, start = { t: 0 }) {
  for (const f of frames) {
    start.t += FRAME_MS;
    counter.update(f, ASPECT, start.t);
  }
}

function sweep(from, to, steps, extra) {
  return Array.from({ length: steps }, (_, i) =>
    frame({ elbowAngle: from + ((to - from) * i) / (steps - 1), ...extra }),
  );
}

const rep = (low = 80, extra = {}) => [
  ...sweep(170, low, 10, extra),
  ...sweep(low, 170, 10, extra),
];

test("numără flotările complete", () => {
  const c = new PushupCounter();
  feed(c, Array.from({ length: 10 }, () => rep()).flat());
  assert.equal(c.count, 10);
});

test("nu numără jumătățile de flotare", () => {
  const c = new PushupCounter();
  feed(c, Array.from({ length: 5 }, () => rep(120)).flat());
  assert.equal(c.count, 0);
});

test("nu numără cu șoldurile lăsate", () => {
  const c = new PushupCounter();
  feed(c, Array.from({ length: 5 }, () => rep(80, { hipSag: 0.18 })).flat());
  assert.equal(c.count, 0);
});

test("nu numără când stai în picioare și îndoi brațele", () => {
  const c = new PushupCounter();
  feed(c, Array.from({ length: 5 }, () => rep(80, { torsoTilt: 0.4 })).flat());
  assert.equal(c.count, 0);
});

test("nu numără dacă umerii nu coboară", () => {
  const c = new PushupCounter();
  feed(c, Array.from({ length: 5 }, () => rep(80, { shoulderDrop: 0 })).flat());
  assert.equal(c.count, 0);
});

test("nu numără când corpul nu se vede", () => {
  const c = new PushupCounter();
  feed(c, Array.from({ length: 5 }, () => rep(80, { visibility: 0.2 })).flat());
  assert.equal(c.count, 0);
});

test("tremuratul în jurul pragului nu adaugă repetări", () => {
  const c = new PushupCounter();
  const shaky = Array.from({ length: 40 }, (_, i) => frame({ elbowAngle: i % 2 ? 148 : 153 }));
  feed(c, [...rep(), ...shaky]);
  assert.equal(c.count, 1);
});

test("mișcările prea rapide nu sunt numărate", () => {
  const c = new PushupCounter({ minRepMs: 5000 });
  feed(c, [...rep(), ...rep()]);
  assert.equal(c.count, 1);
});
