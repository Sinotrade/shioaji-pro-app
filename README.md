# shioaji-pro-app

A web app built on top of [shioaji](https://github.com/Sinotrade/rshioaji) — SinoPac's market-data server. Scaffolded with `create-shioaji-app`.

## Stack

- **React 19** + **TypeScript**
- **Vite 8** (dev server, build)
- **Vanilla Extract** (zero-runtime CSS-in-JS)

## Project layout

```
shioaji-pro-app/
├── public/            Static assets
├── src/
│   ├── components/    UI components
│   ├── hooks/         React hooks
│   ├── lib/           API calls, types, utils
│   ├── App.tsx        Page composition — start editing here
│   ├── main.tsx       React entry point
│   └── theme.css.ts   Theme tokens (light + dark)
├── index.html
├── vite.config.ts
└── package.json
```

## Develop

```sh
pnpm install
pnpm dev
```

Opens at [http://localhost:5173](http://localhost:5173). The dev server proxies `/api` to `http://localhost:8080` — run shioaji locally on that port.

## Build

```sh
pnpm build
pnpm preview
```

When deploying under a subpath (e.g. as a shioaji custom app served at `/apps/shioaji-pro-app/`):

```sh
VITE_BASE=/apps/shioaji-pro-app/ pnpm build
```

## Deploy to shioaji

Upload the contents of `dist/` to your shioaji server.

- **Via dashboard** — open the shioaji dashboard → Custom Apps → upload the `dist/` folder.
- **Via curl** — send every file under `dist/` as a multipart upload:
    ```sh
    find dist -type f -exec curl -X POST http://localhost:8080/api/v1/apps/shioaji-pro-app \
      -F "files=@{}" \;
    ```

Then visit `http://localhost:8080/apps/shioaji-pro-app/`.

## Configuration

Copy `.env.example` to `.env` to override defaults. See the comments inside for each option.
