// `node --import <this file>`: the process runs as on a Node without node:sqlite.
import { register } from "node:module";

register("./unavailable-hooks.mjs", import.meta.url);
