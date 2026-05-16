import type {
  ConfigRegistry,
  Engine,
  Entity,
  Position,
} from "../../../src/index.js";

const CELL = 40;

const PALETTE: Record<string, string> = {
  pond: "#4fa3e0",
  water: "#4fa3e0",
  mountain: "#8c7b6b",
  default: "#c8b89a",
};

// Display symbols for tower archetypes. These could move into each tower
// JSON's meta.symbol field — for now hard-coded here matches the four
// archetypes shipped in demos/shared-data/towers/.
const TOWER_LABELS: Record<string, string> = {
  archer: "A",
  mortar: "M",
  barracks: "B",
  "anti-air": "↑",
};

// Display symbols for enemy archetypes. Same caveat as TOWER_LABELS.
const ENEMY_LABELS: Record<string, string> = {
  grunt: "G",
  bat: "B",
};

const ENEMY_COLOR_AERIAL = "#9b59b6";
const ENEMY_COLOR_GROUND = "#e74c3c";
const GUARD_COLOR = "#f39c12";
const TOWER_COLOR = "#3498db";

interface MapPath {
  readonly id: string;
  readonly kind?: string;
  readonly waypoints: ReadonlyArray<Position>;
}

interface BaseConfig {
  readonly id: string;
  readonly position: Position;
}

interface BlockedRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly kind?: string;
}

interface MapConfig {
  readonly width: number;
  readonly height: number;
  readonly paths: ReadonlyArray<MapPath>;
  readonly bases: ReadonlyArray<BaseConfig>;
}

interface ScenarioConfig {
  readonly map: string;
}

interface EnemyArchetype {
  readonly tags?: ReadonlyArray<string>;
  readonly stats: { readonly hp: number };
}

interface EntityPos {
  readonly x: number;
  readonly y: number;
}

export class GameplayRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly mapCfg: MapConfig;
  private readonly enemyArchetypes: Record<string, EnemyArchetype>;

  private prevPositions = new Map<string, EntityPos>();
  private currPositions = new Map<string, EntityPos>();

  private activeProjectiles: Array<{
    from: Position;
    to: Position;
    born: number;
    ttl: number;
  }> = [];
  private frameCount = 0;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly engine: Engine,
    registry: ConfigRegistry,
    scenarioId: string,
  ) {
    const scenario = (registry.scenarios as Record<string, ScenarioConfig>)[
      scenarioId
    ]!;
    this.mapCfg = (registry.maps as Record<string, MapConfig>)[scenario.map]!;
    this.enemyArchetypes = registry.enemies as Record<string, EnemyArchetype>;

    canvas.width = this.mapCfg.width * CELL;
    canvas.height = this.mapCfg.height * CELL;
    this.ctx = canvas.getContext("2d")!;

    engine.on("towerFired", (e) => {
      const sourcePosition = e["sourcePosition"] as Position | undefined;
      const targetPosition = e["targetPosition"] as Position | undefined;
      if (sourcePosition && targetPosition) {
        this.activeProjectiles.push({
          from: sourcePosition,
          to: targetPosition,
          born: this.frameCount,
          ttl: 8,
        });
      }
    });
  }

  beforeTick(): void {
    this.prevPositions = new Map(this.currPositions);
  }

  afterTick(): void {
    this.currPositions.clear();
    const movers = this.engine.world.query({ all: ["position"] });
    for (const entity of movers) {
      const pos = entity.components.get("position") as Position | undefined;
      if (pos) {
        this.currPositions.set(entity.id, { x: pos.x, y: pos.y });
      }
    }
  }

  draw(t: number): void {
    this.frameCount++;
    const ctx = this.ctx;
    const map = this.mapCfg;

    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.drawGrid(ctx, map);
    this.drawPaths(ctx, map.paths);

    const blockedRegions = this.engine.world.query({ all: ["blockedRegion"] });
    for (const entity of blockedRegions) {
      const r = entity.components.get("blockedRegion") as
        | BlockedRegion
        | undefined;
      if (r) this.drawBlockedRegion(ctx, r);
    }

    this.drawBases(ctx, map.bases);
    this.drawEntities(ctx, t);
    this.drawProjectiles(ctx);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, map: MapConfig): void {
    ctx.strokeStyle = "#ddd";
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= map.width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL, 0);
      ctx.lineTo(x * CELL, map.height * CELL);
      ctx.stroke();
    }
    for (let y = 0; y <= map.height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL);
      ctx.lineTo(map.width * CELL, y * CELL);
      ctx.stroke();
    }
  }

  private drawPaths(
    ctx: CanvasRenderingContext2D,
    paths: ReadonlyArray<MapPath>,
  ): void {
    for (const path of paths) {
      const color = path.kind === "aerial" ? "#b0c8e8" : "#d4c5a0";
      ctx.strokeStyle = color;
      ctx.lineWidth = CELL * 0.8;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      const first = path.waypoints[0];
      if (!first) continue;
      ctx.moveTo((first.x + 0.5) * CELL, (first.y + 0.5) * CELL);
      for (let i = 1; i < path.waypoints.length; i++) {
        const wp = path.waypoints[i]!;
        ctx.lineTo((wp.x + 0.5) * CELL, (wp.y + 0.5) * CELL);
      }
      ctx.stroke();
    }
  }

  private drawBlockedRegion(
    ctx: CanvasRenderingContext2D,
    r: BlockedRegion,
  ): void {
    ctx.fillStyle = PALETTE[r.kind ?? ""] ?? PALETTE.default!;
    ctx.fillRect(r.x * CELL, r.y * CELL, r.width * CELL, r.height * CELL);
    ctx.strokeStyle = "#888";
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x * CELL, r.y * CELL, r.width * CELL, r.height * CELL);
  }

  private drawBases(
    ctx: CanvasRenderingContext2D,
    bases: ReadonlyArray<BaseConfig>,
  ): void {
    for (const base of bases) {
      const cx = (base.position.x + 0.5) * CELL;
      const cy = (base.position.y + 0.5) * CELL;
      ctx.beginPath();
      ctx.arc(cx, cy, CELL * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = "#2ecc71";
      ctx.fill();
      ctx.strokeStyle = "#27ae60";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  private drawEntities(ctx: CanvasRenderingContext2D, t: number): void {
    for (const [id, curr] of this.currPositions) {
      const prev = this.prevPositions.get(id);
      const x = prev ? prev.x + (curr.x - prev.x) * t : curr.x;
      const y = prev ? prev.y + (curr.y - prev.y) * t : curr.y;
      const cx = (x + 0.5) * CELL;
      const cy = (y + 0.5) * CELL;

      const entity = this.engine.world.get(id);
      if (!entity) continue;

      if (entity.components.has("tower")) {
        this.drawTower(ctx, cx, cy, entity);
      } else if (entity.components.has("enemy")) {
        this.drawEnemy(ctx, cx, cy, entity);
      } else if (entity.components.has("guard")) {
        this.drawGuard(ctx, cx, cy, entity);
      }
    }
  }

  private drawTower(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    entity: Entity,
  ): void {
    const archetype = (entity.components.get("tower") as { archetype: string })
      .archetype;
    const label = TOWER_LABELS[archetype] ?? archetype[0]?.toUpperCase() ?? "?";
    ctx.fillStyle = TOWER_COLOR;
    ctx.fillRect(cx - CELL * 0.3, cy - CELL * 0.3, CELL * 0.6, CELL * 0.6);
    this.drawLabel(ctx, cx, cy, label, "#fff", 16);
  }

  private drawEnemy(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    entity: Entity,
  ): void {
    const archetypeId = (
      entity.components.get("enemy") as { archetype: string }
    ).archetype;
    const def = this.enemyArchetypes[archetypeId];
    const isAerial =
      def?.tags?.includes("aerial") || def?.tags?.includes("flying");
    const color = isAerial ? ENEMY_COLOR_AERIAL : ENEMY_COLOR_GROUND;
    const label =
      ENEMY_LABELS[archetypeId] ?? archetypeId[0]?.toUpperCase() ?? "?";

    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    this.drawLabel(ctx, cx, cy, label, "#fff", 13);

    const health = entity.components.get("health") as
      | { hp: number }
      | undefined;
    if (health && def) {
      this.drawHpBar(ctx, cx, cy, health.hp, def.stats.hp);
    }
  }

  private drawGuard(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    entity: Entity,
  ): void {
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = GUARD_COLOR;
    ctx.fill();

    const health = entity.components.get("health") as
      | { hp: number; max: number }
      | undefined;
    if (health) {
      this.drawHpBar(ctx, cx, cy, health.hp, health.max);
    }
  }

  // Thin HP bar drawn below the unit (per request: "under them").
  private drawHpBar(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    hp: number,
    max: number,
  ): void {
    if (max <= 0) return;
    const pct = Math.max(0, Math.min(1, hp / max));
    const w = CELL * 0.7;
    const h = 4;
    const x = cx - w / 2;
    const y = cy + CELL * 0.38;
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = pct > 0.5 ? "#2ecc71" : pct > 0.25 ? "#f39c12" : "#e74c3c";
    ctx.fillRect(x, y, w * pct, h);
    ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x, y, w, h);
  }

  private drawLabel(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    text: string,
    color: string,
    size: number,
  ): void {
    ctx.fillStyle = color;
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cy);
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D): void {
    this.activeProjectiles = this.activeProjectiles.filter(
      (p) => this.frameCount - p.born < p.ttl,
    );
    for (const p of this.activeProjectiles) {
      const age = (this.frameCount - p.born) / p.ttl;
      const x = (p.from.x + (p.to.x - p.from.x) * age + 0.5) * CELL;
      const y = (p.from.y + (p.to.y - p.from.y) * age + 0.5) * CELL;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#f1c40f";
      ctx.fill();
    }
  }
}
