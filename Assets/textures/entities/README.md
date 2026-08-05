# Assets/textures/entities/

Sprite textures for entities. Each entity that draws as a `sprite` names its image
in its def file's `visual.texture` field (a full path), under
[`Assets/jsons/entities/`](../../jsons/entities/) — change a path there to point an
entity at a different PNG.

Drop a PNG here and reference it from a def's `visual.texture`. Several entities can
share one image (e.g. the bugs currently share `bug.png`). Suggested per-species
names:

| entity id | file |
|---|---|
| `baby_ant` | `baby_ant.png` |
| `worker_ant` | `worker_ant.png` |
| `soldier_ant` | `soldier_ant.png` |
| `bee` | `bee.png` |
| `hornet` | `hornet.png` |
| `spider` | `spider.png` |
| `beetle` | `beetle.png` |
| `ladybug` | `ladybug.png` |
| `rock` | `rock.png` |

Until a referenced file exists, the view renders that entity with a white
placeholder (`PIXI.Texture.WHITE`). Textures are preloaded at boot by
`VisualEngine.shared.view.loadTextures()`, which reads every `sprite` visual's
`texture` from the loaded entity defs. (`circle`-drawn entities like the player
reference no texture.)
