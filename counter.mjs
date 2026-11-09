// Numără flotările din punctele corpului returnate de MediaPipe Pose.
// Nu depinde de browser, ca să poată fi testat cu `npm test`.

const SIDES = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28 },
};

const DEFAULTS = {
  minVisibility: 0.5,
  upAngle: 150,
  downAngle: 95,
  minBodyAngle: 150,
  maxTorsoTilt: 40,
  minShoulderTravel: 0.2, // din lungimea trunchiului
  confirmFrames: 2,
  badFormFrames: 6,
  minRepMs: 500,
  smoothing: 0.5,
};

function angleAt(a, b, c) {
  const ab = Math.atan2(a.y - b.y, a.x - b.x);
  const cb = Math.atan2(c.y - b.y, c.x - b.x);
  const deg = Math.abs(ab - cb) * (180 / Math.PI);
  return deg > 180 ? 360 - deg : deg;
}

export class PushupCounter {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.count = 0;
    this.phase = "start"; // start -> up -> down -> up (+1)
    this.elbow = null;
    this.streak = 0;
    this.badStreak = 0;
    this.topY = null;
    this.bottomY = null;
    this.lastRepAt = -Infinity;
  }

  // landmarks: coordonate normalizate 0..1; aspect: lățime / înălțime
  update(landmarks, aspect, timeMs) {
    const pose = this.readPose(landmarks, aspect);
    if (!pose) return this.bad("Nu te văd complet. Pune telefonul lateral, la 2 m.");

    const { shoulder, elbow, wrist, hip, foot, torsoLength } = pose;
    const dx = Math.abs(shoulder.x - hip.x);
    const dy = Math.abs(shoulder.y - hip.y);
    if ((Math.atan2(dy, dx) * 180) / Math.PI > this.opts.maxTorsoTilt) {
      return this.bad("Treci în poziția de flotare.");
    }
    if (angleAt(shoulder, hip, foot) < this.opts.minBodyAngle) {
      return this.bad("Ține corpul drept.");
    }

    this.badStreak = 0;
    const raw = angleAt(shoulder, elbow, wrist);
    const a = this.opts.smoothing;
    this.elbow = this.elbow === null ? raw : a * raw + (1 - a) * this.elbow;
    this.step(shoulder.y, torsoLength, timeMs);
    return this.state(this.hintForPhase());
  }

  step(shoulderY, torsoLength, timeMs) {
    const { upAngle, downAngle, confirmFrames, minShoulderTravel, minRepMs } = this.opts;

    if (this.phase === "start") {
      this.streak = this.elbow >= upAngle ? this.streak + 1 : 0;
      if (this.streak >= confirmFrames) this.enterUp(shoulderY);
    } else if (this.phase === "up") {
      this.topY = Math.min(this.topY, shoulderY);
      this.streak = this.elbow <= downAngle ? this.streak + 1 : 0;
      if (this.streak >= confirmFrames) {
        this.phase = "down";
        this.streak = 0;
        this.bottomY = shoulderY;
      }
    } else {
      this.bottomY = Math.max(this.bottomY, shoulderY);
      this.streak = this.elbow >= upAngle ? this.streak + 1 : 0;
      if (this.streak >= confirmFrames) {
        const travelled = this.bottomY - this.topY >= minShoulderTravel * torsoLength;
        if (travelled && timeMs - this.lastRepAt >= minRepMs) {
          this.count += 1;
          this.lastRepAt = timeMs;
        }
        this.enterUp(shoulderY);
      }
    }
  }

  enterUp(shoulderY) {
    this.phase = "up";
    this.streak = 0;
    this.topY = shoulderY;
    this.bottomY = null;
  }

  readPose(landmarks, aspect) {
    if (!landmarks || landmarks.length < 29) return null;
    const required = ["shoulder", "elbow", "wrist", "hip"];
    const score = (side) =>
      required.reduce((sum, part) => sum + (landmarks[side[part]].visibility ?? 0), 0);
    const side = score(SIDES.left) >= score(SIDES.right) ? SIDES.left : SIDES.right;

    const min = this.opts.minVisibility;
    if (required.some((part) => (landmarks[side[part]].visibility ?? 0) < min)) return null;
    const footIndex = [side.ankle, side.knee].find((i) => (landmarks[i].visibility ?? 0) >= min);
    if (footIndex === undefined) return null;

    // x și y sunt normalizate separat, deci unghiurile cer aceeași scară.
    const point = (i) => ({ x: landmarks[i].x * aspect, y: landmarks[i].y });
    const shoulder = point(side.shoulder);
    const hip = point(side.hip);
    return {
      shoulder,
      hip,
      elbow: point(side.elbow),
      wrist: point(side.wrist),
      foot: point(footIndex),
      torsoLength: Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y),
    };
  }

  bad(hint) {
    this.badStreak += 1;
    this.streak = 0;
    if (this.badStreak >= this.opts.badFormFrames && this.phase !== "start") {
      this.phase = "start";
      this.elbow = null;
    }
    return this.state(hint);
  }

  hintForPhase() {
    if (this.phase === "start") return "Întinde brațele.";
    return this.phase === "up" ? "Coboară." : "Împinge în sus.";
  }

  state(hint) {
    return { count: this.count, phase: this.phase, elbow: this.elbow, hint };
  }
}
