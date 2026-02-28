import React, { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { useTable, useReducer, useSpacetimeDB } from "spacetimedb/react";
import { tables, reducers } from "./module_bindings";

const CELL_SIZE = 16;
const GRID_WIDTH = 60;
const GRID_HEIGHT = 50;
const GAME_WIDTH = GRID_WIDTH * CELL_SIZE;
const GAME_HEIGHT = GRID_HEIGHT * CELL_SIZE;
const MAX_SNAKE_NAMES = 16;

type Dir = "up" | "down" | "left" | "right";

const KEY_TO_DIR: Record<number, Dir> = {
  [Phaser.Input.Keyboard.KeyCodes.UP]: "up",
  [Phaser.Input.Keyboard.KeyCodes.W]: "up",
  [Phaser.Input.Keyboard.KeyCodes.DOWN]: "down",
  [Phaser.Input.Keyboard.KeyCodes.S]: "down",
  [Phaser.Input.Keyboard.KeyCodes.LEFT]: "left",
  [Phaser.Input.Keyboard.KeyCodes.A]: "left",
  [Phaser.Input.Keyboard.KeyCodes.RIGHT]: "right",
  [Phaser.Input.Keyboard.KeyCodes.D]: "right",
};

const KEY_STRING_TO_DIR: Record<string, Dir> = {
  ArrowUp: "up",
  w: "up",
  W: "up",
  ArrowDown: "down",
  s: "down",
  S: "down",
  ArrowLeft: "left",
  a: "left",
  A: "left",
  ArrowRight: "right",
  d: "right",
  D: "right",
};

function isTypingInInput(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    el.getAttribute("contenteditable") === "true"
  );
}

interface GameData {
  snakes: Array<{
    identityHex: string;
    body: Array<{ x: number; y: number }>;
    direction: string;
    nextDirection?: string;
    alive: boolean;
  }>;
  pellets: Array<{ x: number; y: number }>;
  identityToName: Record<string, string>;
  myIdentityHex: string;
}

class SnakeScene extends Phaser.Scene {
  private graphics!: Phaser.GameObjects.Graphics;
  private lastDirKey: number | null = null;
  private nameLabels: Phaser.GameObjects.Text[] = [];

  constructor() {
    super({ key: "Snake" });
  }

  create() {
    this.graphics = this.add.graphics();
    this.cameras.main.setBackgroundColor(0x1a1a2e);
    for (let i = 0; i < MAX_SNAKE_NAMES; i++) {
      const t = this.add.text(0, 0, "", {
        fontSize: "10px",
        color: "#eee",
      });
      t.setOrigin(0.5, 1);
      this.nameLabels.push(t);
    }
    const setDirection = this.registry.get("setDirection") as
      | ((args: { direction: string }) => void)
      | undefined;
    const respawn = this.registry.get("respawn") as (() => void) | undefined;
    this.input.keyboard?.on("keydown", (event: Phaser.Input.Keyboard.Key) => {
      const getData = this.registry.get("getData") as
        | (() => GameData)
        | undefined;
      if (
        event.keyCode === Phaser.Input.Keyboard.KeyCodes.R &&
        respawn &&
        getData
      ) {
        const { snakes, myIdentityHex } = getData();
        const me = snakes.find((s) => s.identityHex === myIdentityHex);
        if (me && !me.alive) {
          respawn();
          return;
        }
      }
      const dir = KEY_TO_DIR[event.keyCode];
      if (dir && setDirection) {
        if (this.lastDirKey !== event.keyCode) {
          this.lastDirKey = event.keyCode;
          setDirection({ direction: dir });
        }
      }
    });
    this.input.keyboard?.on("keyup", (event: Phaser.Input.Keyboard.Key) => {
      if (KEY_TO_DIR[event.keyCode]) this.lastDirKey = null;
    });
  }

  update() {
    const getData = this.registry.get("getData") as
      | (() => GameData)
      | undefined;
    if (!getData) return;
    const { snakes, pellets, identityToName } = getData();
    this.graphics.clear();

    // Grid lines (subtle)
    this.graphics.lineStyle(1, 0x2a2a4e, 0.5);
    for (let x = 0; x <= GRID_WIDTH; x++) {
      this.graphics.lineBetween(x * CELL_SIZE, 0, x * CELL_SIZE, GAME_HEIGHT);
    }
    for (let y = 0; y <= GRID_HEIGHT; y++) {
      this.graphics.lineBetween(0, y * CELL_SIZE, GAME_WIDTH, y * CELL_SIZE);
    }

    // Pellets
    this.graphics.fillStyle(0x00ff88, 1);
    for (const p of pellets) {
      this.graphics.fillCircle(
        p.x * CELL_SIZE + CELL_SIZE / 2,
        p.y * CELL_SIZE + CELL_SIZE / 2,
        CELL_SIZE / 2 - 1,
      );
    }

    // Snakes and names
    const colors = [0xe94560, 0x0f3460, 0x533483, 0xff6b6b];
    let colorIndex = 0;
    for (let si = 0; si < snakes.length; si++) {
      const snake = snakes[si];
      const color = colors[colorIndex % colors.length];
      colorIndex += 1;
      const alpha = snake.alive ? 1 : 0.4;
      for (let i = 0; i < snake.body.length; i++) {
        const seg = snake.body[i];
        const isHead = i === 0;
        this.graphics.fillStyle(isHead ? 0xffffff : color, alpha);
        this.graphics.fillRect(
          seg.x * CELL_SIZE + 1,
          seg.y * CELL_SIZE + 1,
          CELL_SIZE - 2,
          CELL_SIZE - 2,
        );
      }
      const head = snake.body[0];
      if (head && si < this.nameLabels.length) {
        const name =
          identityToName[snake.identityHex] ?? snake.identityHex.slice(0, 8);
        const label = this.nameLabels[si];
        label.setText(name);
        label.setPosition(
          head.x * CELL_SIZE + CELL_SIZE / 2,
          head.y * CELL_SIZE - 2,
        );
        label.setAlpha(snake.alive ? 1 : 0.5);
        label.setVisible(true);
      }
    }
    for (let i = snakes.length; i < this.nameLabels.length; i++) {
      this.nameLabels[i].setVisible(false);
    }
  }
}

export default function Game() {
  const [snakes] = useTable(tables.snake);
  const [pellets] = useTable(tables.pellet);
  const [users] = useTable(tables.user);
  const setDirection = useReducer(reducers.setDirection);
  const setName = useReducer(reducers.setName);
  const respawn = useReducer(reducers.respawn);
  const { identity, isActive: connected } = useSpacetimeDB();
  const [nameInput, setNameInput] = useState("");
  const gameRef = useRef<Phaser.Game | null>(null);
  const myIdentityHex = identity?.toHexString() ?? "";
  const identityToName: Record<string, string> = {};
  for (const u of users) {
    const hex = u.identity.toHexString();
    identityToName[hex] = u.name ?? hex.slice(0, 8);
  }
  const me = users.find((u) => u.identity.toHexString() === myIdentityHex);
  const myName = me?.name;
  const mySnake = snakes.find(
    (s) => s.identity.toHexString() === myIdentityHex,
  );
  const isDead = mySnake && !mySnake.alive;

  const dataRef = useRef<GameData>({
    snakes: [],
    pellets: [],
    identityToName: {},
    myIdentityHex: "",
  });
  const setDirectionRef = useRef(setDirection);
  const respawnRef = useRef(respawn);
  setDirectionRef.current = setDirection;
  respawnRef.current = respawn;

  useEffect(() => {
    dataRef.current = {
      snakes: snakes.map((s) => ({
        identityHex: s.identity.toHexString(),
        body: s.body,
        direction: s.direction,
        nextDirection: s.nextDirection ?? undefined,
        alive: s.alive,
      })),
      pellets: pellets.map((p) => ({ x: p.x, y: p.y })),
      identityToName,
      myIdentityHex,
    };
  }, [snakes, pellets, identityToName, myIdentityHex]);

  // Direction keys at window level so they work even when game canvas doesn't have focus
  const lastDirKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!connected) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingInInput()) return;
      const dir = KEY_STRING_TO_DIR[e.key];
      if (dir && mySnake?.alive && lastDirKeyRef.current !== e.key) {
        lastDirKeyRef.current = e.key;
        e.preventDefault();
        setDirectionRef.current({ direction: dir });
      }
      if (isDead && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        respawnRef.current();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (KEY_STRING_TO_DIR[e.key]) lastDirKeyRef.current = null;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [connected, isDead, mySnake?.alive]);

  useEffect(() => {
    if (!connected) return;
    const game = new Phaser.Game({
      type: Phaser.AUTO,
      width: GAME_WIDTH,
      height: GAME_HEIGHT,
      parent: "game-container",
      pixelArt: true,
      scene: SnakeScene,
      physics: { default: undefined },
      callbacks: {
        postBoot: (gameInstance) => {
          gameInstance.registry.set("getData", () => dataRef.current);
          gameInstance.registry.set(
            "setDirection",
            (args: { direction: string }) => setDirectionRef.current(args),
          );
          gameInstance.registry.set("respawn", () => respawnRef.current());
        },
      },
    });
    gameRef.current = game;

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, [connected]);

  const handleSetName = (e: React.FormEvent) => {
    e.preventDefault();
    const name = nameInput.trim();
    if (name) {
      setName({ name });
      setNameInput("");
    }
  };

  if (!connected || !identity) {
    return (
      <div className="game-loading">
        <h1>Connecting...</h1>
      </div>
    );
  }

  return (
    <div className="game-wrapper">
      <div className="game-topbar">
        <span className="game-username">
          {myName ? (
            <>
              Playing as <strong>{myName}</strong>
            </>
          ) : (
            <form onSubmit={handleSetName} className="game-name-form">
              <input
                type="text"
                placeholder="Enter username"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                maxLength={24}
                autoFocus
              />
              <button type="submit">Set name</button>
            </form>
          )}
        </span>
        {isDead && (
          <span className="game-respawn-hint">
            You died — Press <kbd>R</kbd> to respawn
          </span>
        )}
      </div>
      <div id="game-container" />
    </div>
  );
}
