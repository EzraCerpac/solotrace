/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SOLOTRACE_OWNER_ID_SECRET?: string;
  }
}
