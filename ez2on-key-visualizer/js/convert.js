// Legacy mania conversion ported from rosu-pp (MIT, MaxOhn) and osu!lazer.
// Keep floating-point narrowing and RNG call order: both affect generated patterns.
const f32 = Math.fround;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const roundEven = (n) => {
  const lo = Math.floor(n);
  return n - lo === 0.5 ? lo + (lo % 2 !== 0 ? 1 : 0) : Math.round(n);
};
const column = (x, keys) => clamp(Math.floor(f32(x / f32(512 / keys))), 0, keys - 1);
const LOW = 1,
  NOT_STACK = 2,
  SINGLE = 4,
  STAIR = 8,
  BACK_STAIR = 16,
  CYCLE = 32,
  STACK = 64,
  REVERSE = 128,
  MIRROR = 256,
  GATHER = 512;

class OsuRandom {
  constructor(seed) {
    this.x = seed >>> 0;
    this.y = 842502087;
    this.z = 3579807591;
    this.w = 273326509;
  }
  double() {
    const t = this.x ^ (this.x << 11);
    this.x = this.y;
    this.y = this.z;
    this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return (this.w & 0x7fffffff) / 2147483648;
  }
  range(lo, hi) {
    return lo + Math.trunc(this.double() * (hi - lo));
  }
}
class Pattern {
  constructor() {
    this.notes = [];
    this.columns = new Set();
  }
  add(c, s, e = s) {
    this.notes.push([s, e, c, e !== s]);
    this.columns.add(c);
    return this;
  }
  has(c) {
    return this.columns.has(c);
  }
  get count() {
    return this.columns.size;
  }
  append(p) {
    this.notes.push(...p.notes);
    for (const c of p.columns) this.columns.add(c);
  }
}
function at(points, time, fallback, first = false) {
  let lo = 0,
    hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return points[lo - 1] ?? (first ? points[0] : undefined) ?? fallback;
}
function number(s, limit = 2147483647) {
  if (s == null || !s.trim()) throw new Error("Missing number");
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > limit) throw new Error("Invalid number");
  return n;
}
function parse(text) {
  if (typeof text !== "string" || !/^\ufeff?osu file format v\d+/m.test(text)) return null;
  const m = {
    mode: 0,
    hp: 5,
    cs: 5,
    od: 5,
    ar: 5,
    slider: 1.4,
    objects: [],
    timing: [],
    difficulty: [],
    effect: [],
    breaks: 0,
  };
  let section = "",
    hasAR = false,
    pending = null;
  const insert = (list, p) => {
    let lo = 0,
      hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].time < p.time) lo = mid + 1;
      else hi = mid;
    }
    if (list[lo]?.time === p.time) list[lo] = p;
    else if (lo === list.length) list.push(p);
    else list.splice(lo, 0, p);
  };
  const flush = () => {
    if (!pending) return;
    if (pending.timing) insert(m.timing, pending.timing);
    if (pending.difficulty && pending.difficulty.sv !== at(m.difficulty, pending.time, { sv: 1 }).sv)
      insert(m.difficulty, pending.difficulty);
    if (pending.effect && pending.effect.kiai !== at(m.effect, pending.time, { kiai: false }).kiai)
      insert(m.effect, pending.effect);
    pending = null;
  };
  for (let line of text.split(/\r?\n/)) {
    line = line.split("//")[0].trim();
    if (!line || line.startsWith("osu file format")) continue;
    if (line[0] === "[") {
      section = line;
      continue;
    }
    const colon = line.indexOf(":");
    const key = colon < 0 ? "" : line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (section === "[General]" && key === "Mode") m.mode = number(value);
    else if (section === "[Difficulty]") {
      if (key === "HPDrainRate") m.hp = f32(number(value));
      else if (key === "CircleSize") m.cs = f32(number(value));
      else if (key === "OverallDifficulty") {
        m.od = f32(number(value));
        if (!hasAR) m.ar = m.od;
      } else if (key === "ApproachRate") {
        m.ar = f32(number(value));
        hasAR = true;
      } else if (key === "SliderMultiplier") m.slider = number(value);
    } else if (section === "[Events]") {
      const p = line.split(",");
      if (p[0] === "2" || p[0] === "Break") m.breaks += Math.max(0, number(p[2]) - number(p[1]));
    } else if (section === "[TimingPoints]") {
      const p = line.split(","),
        time = number(p[0]),
        beat = Number(p[1]);
      if (p[1] == null || Math.abs(beat) > 2147483647) throw new Error("Invalid timing");
      const red = p[6] == null || p[6].startsWith("1");
      if (red && !Number.isFinite(beat)) throw new Error("Invalid beat length");
      if (pending && pending.time !== time) flush();
      if (!pending) pending = { time };
      const push = (name, point) => {
        if (!red || !pending[name]) pending[name] = point;
      };
      if (red) push("timing", { time, beat: clamp(beat, 6, 60000) });
      push("difficulty", { time, sv: clamp(beat < 0 ? 100 / -beat : 1, 0.1, 10) });
      push("effect", { time, kiai: ((Number(p[7]) || 0) & 1) !== 0 });
    } else if (section === "[HitObjects]") {
      const p = line.split(","),
        x = Math.trunc(f32(number(p[0], 131072))),
        y = Math.trunc(f32(number(p[1], 131072))),
        s = number(p[2]),
        type = number(p[3]);
      const o = { x, y, s, e: s, sound: number(p[4]), kind: 0 };
      if (type & 1) o.kind = 0;
      else if (type & 2) {
        o.kind = 1;
        o.spans = Math.max(1, number(p[6]));
        if (o.spans > 9000) throw new Error("Invalid repeat count");
        o.dist = p[7] == null ? 0 : Math.max(0, number(p[7], 131072));
        o.nodes = new Array(o.spans + 1).fill(o.sound);
        if (p[8] != null)
          p[8]
            .split("|")
            .slice(0, o.nodes.length)
            .forEach((v, i) => {
              o.nodes[i] = Number(v) || 0;
            });
      } else if (type & 8) {
        o.kind = 2;
        o.e = Math.max(s, number(p[5]));
      } else if (type & 128) {
        o.kind = 3;
        o.e = p[5] ? Math.max(s, number(p[5].split(":")[0])) : s;
      } else throw new Error("Unknown hit object");
      m.objects.push(o);
    }
  }
  flush();
  // lazer corrects pre-v5 client-level timing; rosu-pp leaves these times raw.
  if (Number(text.match(/osu file format v(\d+)/)[1]) < 5) {
    for (const o of m.objects) {
      o.s += 24;
      o.e += 24;
    }
    for (const points of [m.timing, m.difficulty, m.effect]) for (const p of points) p.time += 24;
  }
  m.hp = clamp(m.hp, 0, 10);
  m.od = clamp(m.od, 0, 10);
  m.ar = clamp(m.ar, 0, 10);
  m.cs = clamp(m.cs, m.mode === 3 ? 1 : 0, m.mode === 3 ? 18 : 10);
  m.slider = clamp(m.slider, 0.4, 3.6);
  m.objects.sort((a, b) => a.s - b.s);
  return m;
}
class Generator {
  constructor(o, keys, random, map, prev) {
    this.o = o;
    this.keys = keys;
    this.random = random;
    this.map = map;
    this.prev = prev;
    this.type = 0;
  }
  get lower() {
    return this.keys === 8 ? 1 : 0;
  }
  col() {
    return this.keys === 8
      ? clamp(Math.floor(f32(this.o.x / f32(512 / 7))), 0, 6) + 1
      : column(this.o.x, this.keys);
  }
  randomCol(lo = this.lower, hi = this.keys) {
    return this.random.range(lo, hi);
  }
  count(p2, p3, p4 = 0, p5 = 0, p6 = 0) {
    const v = this.random.double();
    return v >= 1 - p6 ? 6 : v >= 1 - p5 ? 5 : v >= 1 - p4 ? 4 : v >= 1 - p3 ? 3 : 1 + (v >= 1 - p2 ? 1 : 0);
  }
  available(
    c,
    patterns = [],
    valid = () => true,
    lo = this.lower,
    hi = this.keys,
    next = () => this.randomCol(lo, hi),
  ) {
    const ok = (n) => valid(n) && patterns.every((p) => !p.has(n));
    if (ok(c)) return c;
    let free = false;
    for (let i = lo; i < hi; i++)
      if (ok(i)) {
        free = true;
        break;
      }
    if (!free) throw new Error("No available column");
    do {
      c = next(c);
    } while (!ok(c));
    return c;
  }
}
function circle(g, last, density) {
  const { o, keys: k, prev } = g,
    dt = o.s - last.time;
  const dx = f32(o.x - last.x),
    dy = f32(o.y - last.y);
  const distance = f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy))));
  const beat = at(g.map.timing, o.s, { beat: 1000 }, true).beat;
  let t =
    dt <= 80
      ? NOT_STACK | SINGLE
      : dt <= 95
        ? NOT_STACK | SINGLE | last.stair
        : dt <= 105
          ? NOT_STACK | LOW
          : dt <= 125
            ? NOT_STACK
            : dt <= 135 && distance < 20
              ? CYCLE | SINGLE
              : dt <= 150 && distance < 20
                ? STACK | LOW
                : distance < 20 && density >= beat / 2.5
                  ? REVERSE | LOW
                  : density < beat / 2.5 || at(g.map.effect, o.s, { kiai: false }).kiai
                    ? 0
                    : LOW;
  if (!(t & SINGLE)) {
    if (o.sound & 4 && k !== 8) t |= MIRROR;
    else if (o.sound & 8) t |= GATHER;
  }
  g.type = t;
  const single = (c) => new Pattern().add(c, o.s);
  const special = () => {
    return g.lower > 0 && (o.sound & 12) === 12;
  };
  const randomNotes = (n) => {
    const p = new Pattern(),
      stack = !(t & NOT_STACK);
    if (!stack) n = Math.min(k - g.lower - prev.count, n);
    let c = g.col();
    for (let i = 0; i < n; i++) {
      c = g.available(c, stack ? [p] : [p, prev], undefined, g.lower, k, (old) =>
        t & GATHER ? (old + 1 === k ? g.lower : old + 1) : g.randomCol(),
      );
      p.add(c, o.s);
    }
    return p;
  };
  const randomPattern = (p2, p3, p4 = 0, p5 = 0) => {
    if (k === 2) p2 = p3 = p4 = p5 = 0;
    else if (k === 3) {
      p2 = Math.min(p2, 0.1);
      p3 = p4 = p5 = 0;
    } else if (k === 4) {
      p2 = Math.min(p2, 0.23);
      p3 = Math.min(p3, 0.04);
      p4 = p5 = 0;
    } else if (k === 5) {
      p3 = Math.min(p3, 0.15);
      p4 = Math.min(p4, 0.03);
      p5 = 0;
    }
    if (o.sound & 8) p2 = 1;
    const p = randomNotes(g.count(p2, p3, p4, p5));
    if (special()) p.add(0, o.s);
    return p;
  };
  const mirrored = (centre, p2, p3) => {
    if (t & NOT_STACK) return randomPattern(0.5 + p2 / 2, p2, (p2 + p3) / 2, p3);
    if (k === 2) centre = p2 = p3 = 0;
    else if (k === 3) {
      centre = Math.min(centre, 0.03);
      p2 = p3 = 0;
    } else if (k === 4) {
      centre = 0;
      p2 = 1 - Math.max((1 - p2) * 2, 0.8);
      p3 = 0;
    } else if (k === 5) {
      centre = Math.min(centre, 0.03);
      p3 = 0;
    } else if (k === 6) {
      centre = 0;
      p2 = 1 - Math.max((1 - p2) * 2, 0.05);
      p3 = 1 - Math.max((1 - p3) * 2, 0.85);
    }
    const centreVal = g.random.double(),
      n = g.count(clamp(p2, 0, 1), clamp(p3, 0, 1));
    const limit = Math.floor(k / 2),
      p = new Pattern();
    let c = g.randomCol(g.lower, limit);
    for (let i = 0; i < n; i++) {
      c = g.available(c, [p], undefined, g.lower, limit);
      p.add(c, o.s).add(g.lower + k - c - 1, o.s);
    }
    if (k % 2 && n !== 3 && centreVal > 1 - centre) p.add(Math.floor(k / 2), o.s);
    if (special()) p.add(0, o.s);
    return p;
  };
  let p;
  const lastCol = prev.notes.length ? prev.notes[prev.notes.length - 1][2] : 0;
  if (k === 1) p = single(0);
  else if (t & REVERSE && prev.notes.length) {
    p = new Pattern();
    for (let i = g.lower; i < k; i++) if (prev.has(i)) p.add(g.lower + k - i - 1, o.s);
  } else if (
    t & CYCLE &&
    prev.notes.length === 1 &&
    (k !== 8 || lastCol !== 0) &&
    (k % 2 === 0 || lastCol !== Math.floor(k / 2))
  )
    p = single(g.lower + k - lastCol - 1);
  else if (t & STACK && prev.notes.length) {
    p = new Pattern();
    for (let i = g.lower; i < k; i++) if (prev.has(i)) p.add(i, o.s);
  } else if (prev.notes.length === 1 && t & STAIR) p = single(lastCol + 1 === k ? g.lower : lastCol + 1);
  else if (prev.notes.length === 1 && t & BACK_STAIR)
    p = single(lastCol - 1 === g.lower - 1 ? k - 1 : lastCol - 1);
  else if (t & SINGLE) p = randomNotes(1);
  else {
    const d = g.map.diff;
    if (t & MIRROR)
      p = d > 6.5 ? mirrored(0.12, 0.38, 0.12) : d > 4 ? mirrored(0.12, 0.17, 0) : mirrored(0.12, 0, 0);
    else if (d > 6.5) p = t & LOW ? randomPattern(0.78, 0.42) : randomPattern(1, 0.62);
    else if (d > 4) p = t & LOW ? randomPattern(0.35, 0.08) : randomPattern(0.52, 0.15);
    else if (d > 2) p = t & LOW ? randomPattern(0.18, 0) : randomPattern(0.45, 0);
    else p = randomPattern(0, 0);
  }
  for (const n of p.notes) {
    if (t & STAIR && n[2] === k - 1) last.stair = BACK_STAIR;
    if (t & BACK_STAIR && n[2] === g.lower) last.stair = STAIR;
  }
  return p;
}
function path(g) {
  const { o, keys: k, prev } = g,
    start = roundEven(o.s),
    spans = o.spans;
  const sv = at(g.map.difficulty, o.s, { sv: 1 }).sv;
  const beat = at(g.map.timing, o.s, { beat: 1000 }, true).beat * (clamp(f32(100 / sv), 10, 10000) / 100);
  const end = Math.floor(start + (o.dist * beat * spans * 0.01) / g.map.slider),
    seg = Math.trunc((end - start) / spans);
  g.type = at(g.map.effect, o.s, { kiai: false }).kiai ? 0 : LOW;
  const d = g.map.diff;
  const randomHolds = (n) => {
    const p = new Pattern(),
      usable = k - g.lower - prev.count;
    let c = g.randomCol();
    for (let i = 0; i < Math.min(usable, n); i++) {
      c = g.available(c, [p, prev]);
      p.add(c, start, end);
    }
    for (let i = 0; i < Math.max(0, n - usable); i++) {
      c = g.available(c, [p]);
      p.add(c, start, end);
    }
    return p;
  };
  const randomNotes = (n) => {
    let c = g.col();
    if (g.type & NOT_STACK && prev.count < k) c = g.available(c, [prev]);
    let time = start;
    const p = new Pattern();
    for (let i = 0; i < n; i++) {
      p.add(c, time);
      const last = c;
      c = g.available(c, [], (v) => v !== last);
      time += seg;
    }
    return p;
  };
  const nHolds = (p2, p3, p4) => {
    if (k === 2) p2 = p3 = p4 = 0;
    else if (k === 3) {
      p2 = Math.min(p2, 0.1);
      p3 = p4 = 0;
    } else if (k === 4) {
      p2 = Math.min(p2, 0.3);
      p3 = Math.min(p3, 0.04);
      p4 = 0;
    } else if (k === 5) {
      p2 = Math.min(p2, 0.34);
      p3 = Math.min(p3, 0.1);
      p4 = Math.min(p4, 0.03);
    }
    if (!(g.type & LOW) && (o.sound | (o.nodes[0] ?? o.sound)) & 12) p2 = 1;
    return randomHolds(g.count(p2, p3, p4));
  };
  let p;
  if (k === 1) p = new Pattern().add(0, start, end);
  else if (spans > 1) {
    if (seg <= 90) p = randomHolds(1);
    else if (seg <= 120) {
      g.type |= NOT_STACK;
      p = randomNotes(spans + 1);
    } else if (seg <= 160) {
      let c = g.col(),
        increasing = g.random.double() > 0.5;
      p = new Pattern();
      for (let i = 0; i <= spans; i++) {
        p.add(c, start + i * seg);
        if (increasing) {
          if (c >= k - 1) {
            increasing = false;
            c--;
          } else c++;
        } else if (c <= g.lower) {
          increasing = true;
          c++;
        } else c--;
      }
    } else if (seg <= 200 && d > 3) {
      const legacy = k >= 4 && k <= 8 ? 1 : 0,
        interval = g.random.range(1, k - legacy);
      let c = g.col();
      p = new Pattern();
      for (let i = 0; i <= spans; i++) {
        const time = start + i * seg;
        p.add(c, time);
        c += interval;
        if (c >= k - g.lower) c = c - k - g.lower + legacy;
        c += g.lower;
        if (k > 2) p.add(c, time);
        c = g.randomCol();
      }
    } else if (end - start >= 4000) p = nHolds(0.23, 0, 0);
    else if (seg > 400 && spans < k - 1 - g.lower) {
      let c = g.col();
      p = new Pattern();
      if (g.type & NOT_STACK && prev.count < k) c = g.available(c, [prev]);
      for (let i = 0; i < Math.min(spans, k); i++) {
        c = g.available(c, [p]);
        p.add(c, start + i * seg, start + seg * spans);
      }
    } else {
      p = new Pattern();
      let hold = g.col();
      if (g.type & NOT_STACK && prev.count < k) hold = g.available(hold, [prev]);
      p.add(hold, start, end);
      let c = g.randomCol(),
        n =
          d > 6.5
            ? g.count(0.63, 0)
            : d > 4
              ? g.count(k < 6 ? 0.12 : 0.45, 0)
              : d > 2.5
                ? g.count(k < 6 ? 0 : 0.24, 0)
                : 0;
      n = Math.min(n, k - 1);
      const ignoreHead = !((o.nodes[0] ?? o.sound) & 14);
      for (let i = 0; i <= spans; i++) {
        const row = new Pattern();
        if (!(ignoreHead && i === 0))
          for (let j = 0; j < n; j++) {
            c = g.available(c, [row], (v) => v !== hold);
            row.add(c, start + i * seg);
          }
        p.append(row);
      }
    }
  } else if (seg <= 110) {
    if (prev.count < k) g.type |= NOT_STACK;
    p = randomNotes(1 + (seg >= 80 ? 1 : 0));
  } else if (d > 6.5) p = g.type & LOW ? nHolds(0.78, 0.3, 0) : nHolds(0.85, 0.36, 0.03);
  else if (d > 4) p = g.type & LOW ? nHolds(0.43, 0.08, 0) : nHolds(0.56, 0.18, 0);
  else if (d > 2.5) p = g.type & LOW ? nHolds(0.3, 0, 0) : nHolds(0.37, 0.08, 0);
  else p = g.type & LOW ? nHolds(0.17, 0, 0) : nHolds(0.27, 0, 0);
  if (p.notes.length === 1) return { patterns: [p], seg };
  const intermediate = new Pattern(),
    ending = new Pattern();
  for (const n of p.notes) (roundEven(n[1]) === end ? ending : intermediate).add(n[2], n[0], n[1]);
  return { patterns: [intermediate, ending], seg };
}
function endObject(g) {
  const { o, keys: k, prev } = g;
  let c;
  if (k === 8 && o.sound & 4 && o.e - o.s < 1000) c = 0;
  else {
    const lo = k === 8 ? g.lower : 0;
    c = g.randomCol(lo);
    c = g.available(c, prev.count === k ? [] : [prev], undefined, lo);
  }
  return new Pattern().add(c, o.s, o.e - o.s >= 100 ? o.e : o.s);
}
function targetColumns(m) {
  const cs = roundEven(m.cs),
    od = roundEven(m.od),
    len = m.objects.length;
  if (len) {
    const percent = m.objects.filter((o) => o.kind === 1 || o.kind === 2).length / len;
    if (percent < 0.2) return 7;
    if (percent < 0.3 || cs >= 5) return 6 + (od > 5 ? 1 : 0);
    if (percent > 0.6) return 4 + (od > 4 ? 1 : 0);
  }
  return clamp(od + 1, 4, 7);
}
function legacySort(notes) {
  const cmp = (a, b) => roundEven(a[0]) - roundEven(b[0]);
  const swap = (a, b) => {
    const v = notes[a];
    notes[a] = notes[b];
    notes[b] = v;
  };
  const down = (i, n, lo) => {
    while (i <= Math.floor(n / 2)) {
      let child = 2 * i;
      if (child < n && cmp(notes[lo + child - 1], notes[lo + child]) < 0) child++;
      if (cmp(notes[lo + i - 1], notes[lo + child - 1]) >= 0) break;
      swap(lo + i - 1, lo + child - 1);
      i = child;
    }
  };
  const quick = (left, right, depth) => {
    do {
      if (depth === 0) {
        const n = right - left + 1;
        for (let i = Math.floor(n / 2); i >= 1; i--) down(i, n, left);
        for (let i = n; i >= 2; i--) {
          swap(left, left + i - 1);
          down(1, i - 1, left);
        }
        return;
      }
      let i = left,
        j = right;
      const middle = i + ((j - i) >>> 1);
      for (const [a, b] of [
        [i, middle],
        [i, j],
        [middle, j],
      ])
        if (a !== b && cmp(notes[a], notes[b]) > 0) swap(a, b);
      while (true) {
        while (cmp(notes[i], notes[middle]) < 0) i++;
        while (cmp(notes[middle], notes[j]) < 0) j--;
        if (i > j) break;
        if (i < j) swap(i, j);
        i++;
        j = Math.max(0, j - 1);
        if (i > j) break;
      }
      depth--;
      if (Math.max(0, j - left) <= right - i) {
        if (left < j) quick(left, j, depth);
        left = i;
      } else {
        if (i < right) quick(i, right, depth);
        right = j;
      }
    } while (left < right);
  };
  if (notes.length > 1) quick(0, notes.length - 1, 32);
}
/**
 * @param {string} text .osu file contents
 * @param {{targetKeys?: number|null, dual?: boolean, holdOff?: boolean, invert?: boolean}} options
 * @returns {{keyCount: number, notes: Float64Array[]} | null}
 */
export function maniaNotes(text, options = {}) {
  try {
    const m = parse(text);
    if (!m || (m.mode !== 0 && m.mode !== 3)) return null;
    const keys =
      m.mode === 3
        ? roundEven(m.cs)
        : (Number.isInteger(options.targetKeys) && options.targetKeys >= 1 && options.targetKeys <= 10
            ? options.targetKeys
            : targetColumns(m)) * (options.dual ? 2 : 1);
    let notes = [];
    if (m.mode === 3) {
      for (const o of m.objects)
        if (o.kind === 0 || o.kind === 3)
          notes.push([
            o.s,
            o.kind === 3 ? o.e : o.s,
            clamp(Math.floor((o.x * keys) / 512), 0, keys - 1),
            o.kind === 3,
          ]);
    } else {
      const seed = roundEven(f32(m.hp + m.cs)) * 20 + Math.trunc(f32(m.od * f32(41.2))) + roundEven(m.ar),
        rng = new OsuRandom(seed);
      let drain = Math.trunc(((m.objects.at(-1)?.s ?? 0) - (m.objects[0]?.s ?? 0) - m.breaks) / 1000);
      if (drain === 0) drain = 10000;
      m.diff = Math.min(
        12,
        (((f32(m.hp + clamp(m.ar, 4, 7)) / 1.5 + (m.objects.length / drain) * 9) / 38) * 5) / 1.15,
      );
      const last = { time: 0, x: 0, y: 0, pattern: new Pattern(), stair: STAIR },
        times = [];
      let density = 2147483647;
      const densityAt = (time) => {
        times.push(time);
        if (times.length > 7) times.shift();
        if (times.length > 1) density = (times[times.length - 1] - times[0]) / times.length;
      };
      for (const o of m.objects) {
        const g = new Generator(o, keys, rng, m, last.pattern);
        if (o.kind === 0) {
          densityAt(o.s);
          const p = circle(g, last, density);
          notes.push(...p.notes);
          last.time = o.s;
          last.x = o.x;
          last.y = o.y;
          last.pattern = p;
        } else if (o.kind === 1) {
          const result = path(g);
          for (let i = 0; i <= o.spans; i++) {
            last.time = o.s + result.seg * i;
            last.x = o.x;
            last.y = o.y;
            densityAt(last.time);
          }
          for (const p of result.patterns) {
            notes.push(...p.notes);
            last.pattern = p;
          }
        } else {
          const p = endObject(g);
          notes.push(...p.notes);
          last.time = o.e;
          last.x = 256;
          last.y = 192;
          densityAt(o.e);
        }
      }
      notes.sort((a, b) => a[0] - b[0]);
    }
    if (options.holdOff) {
      notes = notes
        .filter((n) => !n[3])
        .concat(notes.filter((n) => n[3]).map((n) => [n[0], n[0], n[2], false]));
      notes.sort((a, b) => a[0] - b[0]);
    }
    if (options.invert) {
      const columns = Array.from({ length: keys }, () => []),
        inverted = [];
      for (const n of notes) columns[n[2]].push(n[0]);
      for (let c = 0; c < keys; c++) {
        const times = columns[c].sort((a, b) => a - b);
        for (let i = 1; i < times.length; i++) {
          const s = times[i - 1],
            end = times[i],
            duration = end - s,
            beat = at(m.timing, end, { beat: 1000 }, true).beat;
          inverted.push([s, s + Math.max(duration / 2, duration - beat / 4), c]);
        }
      }
      notes = inverted.sort((a, b) => a[0] - b[0]);
    }
    legacySort(notes);
    // Rounded-time legacy sorting can put sub-millisecond starts out of order.
    notes.sort((a, b) => a[0] - b[0]);
    const starts = new Float64Array(notes.length),
      ends = new Float64Array(notes.length),
      columns = new Float64Array(notes.length);
    for (let i = 0; i < notes.length; i++) {
      starts[i] = notes[i][0];
      ends[i] = notes[i][1];
      columns[i] = notes[i][2];
    }
    return { keyCount: keys, notes: [starts, ends, columns] };
  } catch {
    return null;
  }
}
