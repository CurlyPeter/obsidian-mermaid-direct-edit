/** Flowcharts the tests run against: the two test pages and diagrams shaped like real ones. */

export const DEMO = `flowchart TD
  Customer([Customer orders tea]) --> Stock{Tea in stock?}
  Stock -->|yes| Brew[Brew tea]
  Stock -->|no| Offer[Offer an alternative]
  Offer -.->|accepted| Brew
  subgraph Kitchen [Kitchen]
    direction TB
    Brew --> Water[(Hot water)]
    Water ==> Cup[[Pour into cup]]
  end
  Cup --> Serve(Serve) --> Pay[/Pay at the counter/]
  Pay --> Done((Done))
  Customer -- feedback --> Log[(Order log)]
  Serve & Pay --> Log
  classDef warm fill:#fde2c8,stroke:#d9822b
  class Brew,Cup warm
  style Done fill:#d3f9d8,stroke:#2b8a3e`;

export const ALL = `---
title: Flowchart, all elements
---
flowchart LR
  accTitle: Every element of a Mermaid flowchart
  accDescr: Shapes, link kinds, labels, subgraphs, classes and styles in one diagram
  %% Classic shapes
  subgraph Shapes [Classic shapes]
    direction TB
    S1[Rectangle] --- S2(Rounded) --- S3([Stadium]) --- S4[[Subroutine]] --- S5[(Database)]
    S6((Circle)) --- S7>Flag] --- S8{Decision} --- S9{{Hexagon}} --- S10[/Parallelogram/]
    S11[\\Parallelogram alt\\] --- S12[/Trapezoid\\] --- S13[\\Trapezoid alt/] --- S14(((Double circle)))
  end
  %% Shapes of the new syntax
  subgraph New [New shape syntax]
    N1@{ shape: doc, label: "Document" }
    N2@{ shape: delay, label: "Delay" }
    N3@{ shape: manual-input, label: "Manual input" }
    N1 --> N2 --> N3
  end
  %% Link kinds
  L1 --> L2
  L1 --- L3
  L1 -.-> L4
  L1 -.- L5
  L1 ==> L6
  L1 === L7
  L1 --o L8
  L1 --x L9
  L1 <--> L10
  L1 o--o L11
  L1 x--x L12
  L1 ~~~ L13
  L1 ----> L14
  %% Labels, both forms, and an edge id
  A["Quoted label<br/>with a line break"] -->|pipe label| B
  B -- inline label --> C
  B -. dotted label .-> D
  B == thick label ==> E
  C e1@--> E
  F["\`**Markdown** label\`"] --> A
  %% Chain and groups; two statements on one line
  G1 --> G2 --> G3; G3 --> G4
  G1 & G2 --> H1 & H2
  %% Nested subgraphs, a link to a subgraph
  subgraph Outer [Outer group]
    subgraph Inner [Inner group]
      I1 --> I2
    end
    I2 --> I3
  end
  Outer --> L1
  %% Classes and styles
  classDef hot fill:#ffd8a8,stroke:#e8590c
  classDef cool fill:#d0ebff,stroke:#1c7ed6
  X1:::hot --> X2:::cool
  class G1,G2 hot
  style X2 stroke-width:3px
  linkStyle 0 stroke:#e8590c,stroke-width:2px`;

/** Shaped like real diagrams in use (names replaced). */
/** Shaped like diagrams in real use (the syntax kept, the content neutral). */
export const REAL = [
	`flowchart LR
  subgraph shop["Shop (front, no kitchen)"]
    direction TB
    UI["Counter (till)"]
    PROV["order screen<br/>touch input · receipt printer<br/>queue view (reused)"]
    UI --- PROV
  end

  subgraph back["kitchen (7 days)"]
    direction TB
    D["chef (lead)<br/>/orders · /stock/&lt;item&gt;"]
    SHIM["pass: plates as ordered"]
    CLI["oven (gas)"]
    D --- SHIM
    SHIM -->|tray by tray| CLI
  end

  DESK["Delivery van<br/>own route unchanged"]
  VAULT[("Pantry")]

  PROV <-->|"radio / bell<br/>table numbers"| D
  DESK <-->|same chef| D
  shop <-.->|"Deliveries<br/>(never through the dining room)"| VAULT
  back <-.-> VAULT

  style SHIM stroke-dasharray: 4 4`,
	`flowchart TB
  classDef same fill:#1b4332,stroke:#52b788,color:#ffffff
  classDef todo fill:#4a3a00,stroke:#ffd60a,color:#ffffff,stroke-dasharray: 5 3

  subgraph garden["Garden · Beds (no greenhouse, no heating)"]
    direction TB
    PUI["beds/front<br/>flowers"]:::same
    PCORE["paths/<br/>gravel · stones"]:::same
    PTX["water/rain/<br/>barrel"]:::same
    PVR["water/pump<br/>small pump · phase 3"]:::todo
    PWS["hose/reel<br/>green hose"]:::todo
    PWS -->|water| PTX -->|overflow| PCORE --> PUI
    PVR -.->|feeds| PWS
    PCORE -.->|drains to| PVR
  end`,
	`flowchart TD
    A[Bell rings at the gate<br/>someone must be home] --> B[Open the door<br/>greet, take coats]
    B --> C[check-list.txt<br/>names and seats only]
    C --> D{guest list as table}
    D -->|unknown guest| E[write a name card<br/>table free, no menu]
    D -->|regular| F[usual seat by the window<br/>light on/off]
    D -->|booked true| H[mark: seated + time]
    F --> I[waiter round<br/>drinks, bread]
    H --> J[kitchen ticket<br/>table only, under 40 words]
    K --> N[close-table]
    C --> O
    E --> P[Evening log<br/>covers + incidents]
    O --> P`,
];
