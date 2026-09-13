import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

// Declarations share private renderer types, but must not require the app's @ alias.
const root = path.resolve(
  import.meta.dirname,
  "../packages/transcript/dist/types",
)
async function portableDeclarations(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await portableDeclarations(file)
    else if (entry.name.endsWith(".d.ts")) {
      const source = await readFile(file, "utf8")
      const portable = source.replace(
        /(from\s+|import\s*\()(["'])([^"']+)\2/g,
        (match, prefix, quote, specifier: string) => {
          if (!specifier.startsWith("@/") && !specifier.startsWith("."))
            return match
          let relative = specifier.startsWith("@/")
            ? path.relative(directory, path.join(root, specifier.slice(2)))
            : specifier
          if (!relative.startsWith(".")) relative = `./${relative}`
          if (!relative.endsWith(".js")) relative += ".js"
          return `${prefix}${quote}${relative}${quote}`
        },
      )
      await writeFile(file, portable)
    }
  }
}
await portableDeclarations(root)
// React's client boundary must survive the library bundler for Next consumers.
const reactEntry = path.join(root, "../react.js")
const reactSource = await readFile(reactEntry, "utf8")
if (!reactSource.startsWith('"use client"'))
  await writeFile(reactEntry, `"use client";\n${reactSource}`)

// Ship opt-in styles without resetting an embedding app's body, controls, or theme.
// @scope is supported by the reader's modern browser baseline. Property registrations
// and keyframes are document-level CSS constructs; all selector rules stay scoped.
const { default: postcss } = await import("postcss")
const cssPath = path.join(root, "../styles.css")
const css = postcss.parse(await readFile(cssPath, "utf8"))
css.walkRules((rule) => {
  rule.selector = rule.selector.replace(/:root|:host\b/g, ":scope")
})
const scoped = postcss.atRule({
  name: "scope",
  params: "(.agentchats-transcript)",
})
const globalRules: import("postcss").AtRule[] = []
css.walkAtRules((rule) => {
  if (rule.name === "property" || rule.name === "keyframes") {
    globalRules.push(rule.clone())
    rule.remove()
  }
})
scoped.append(...css.nodes.map((node) => node.clone()))
await writeFile(
  cssPath,
  postcss.root({ nodes: [...globalRules, scoped] }).toString(),
)
