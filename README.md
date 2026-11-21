# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/udgraphiccs/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/udgraphiccs/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for [make.fun](https://make.fun/bounty/sokoban-solver-01-run-20261121). One Node 22 program (`main.ts`) answers all 5 instances of a set in one run, in LURD moves.

## How it works

Every generated level is a hallway with independent rooms off it — a box pushed into the hallway can never come back, so each room's boxes stay in that room. The solver splits a level into rooms (cutting the hallway's dead squares out of the floor), solves each room on its own with A* over pushes, and stitches the room solutions together with walks along the hallway.

Inside a room the search is A* over pushes: a state is the boxes' squares plus the player's reachable region. The heuristic is the cheapest assignment of boxes to goals by walking distance, which never overestimates the pushes still needed, so the first solved state popped is push-optimal. Two deadlocks are pruned: boxes on dead squares (found by pulling boxes back from the goals) and boxes caught in frozen 2×2 blocks of walls and boxes. Work is budgeted by state counts, never by the wall clock, so two runs write identical bytes.

## Practice score

1,000,000 on the kit practice set — all 5 instances solved in exactly P* pushes (13, 16, 29, 47, 60), in ~0.4 s for the whole set. The house baseline plain-astar 1.0.0 scores 200,000 on the same set. The solver also scores 1,000,000 on 10 freshly drawn random sets from the kit generator.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=7qx31218&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
