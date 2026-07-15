// ---------------------------------------------------------------------------
// connectors/github/tools.js — orchestrator only.
// Each domain is implemented in its own module; register them all here.
// To add a new group: create connectors/github/<name>.js and call register().
// ---------------------------------------------------------------------------

import { z } from "zod";
import { register as registerDownload  } from "./download.js";
import { register as registerFiles     } from "./files.js";
import { register as registerBranches  } from "./branches.js";
import { register as registerPRs       } from "./prs.js";
import { register as registerIssues    } from "./issues.js";
import { register as registerReleases  } from "./releases.js";
import { register as registerRepo      } from "./repo.js";
import { register as registerSearch    } from "./search.js";
import { register as registerActions   } from "./actions.js";
import { register as registerStrReplace} from "./str_replace.js";
import { register as registerDiff      } from "./diff.js";
import { register as registerRepoMgmt } from "./repo_mgmt.js";

export function register(server) {
  // Wrap server.tool so every tool registered below is captured into a
  // catalog automatically -- no manual list to keep in sync as tools are
  // added, renamed, or removed. Only intercepts the public .tool() call
  // every connector file already makes; doesn't touch any SDK internals.
  const catalog = [];
  const trackedServer = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === "tool") {
        return (name, description, ...rest) => {
          catalog.push({ name, description });
          return target.tool(name, description, ...rest);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  registerDownload(trackedServer);
  registerFiles(trackedServer);
  registerBranches(trackedServer);
  registerPRs(trackedServer);
  registerIssues(trackedServer);
  registerReleases(trackedServer);
  registerRepo(trackedServer);
  registerSearch(trackedServer);
  registerActions(trackedServer);
  registerStrReplace(trackedServer);
  registerDiff(trackedServer);
  registerRepoMgmt(trackedServer);

  // Registered on the real server (not trackedServer) so it doesn't catalog itself.
  server.tool(
    "list_github_tools",
    "List every tool available in the GitHub connector with a one-line description each. Use this when unsure which GitHub tool fits a task, or as a reliable fallback when a keyword search doesn't surface the right tool.",
    {},
    async () => {
      const lines = catalog
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => `\u2022 ${t.name} \u2014 ${t.description}`);
      return { content: [{ type: "text", text: `GitHub connector tools (${catalog.length}):\n\n${lines.join("\n")}` }] };
    }
  );
}
