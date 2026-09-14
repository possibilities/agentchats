import { Children, isValidElement, memo, useState, type ReactNode } from "react"
import { common, createLowlight } from "lowlight"
import { CheckIcon, CopyIcon } from "lucide-react"
import ReactMarkdown, { type Components } from "react-markdown"
import rehypeHighlight from "rehype-highlight"
import remarkGfm from "remark-gfm"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join("")
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textFromNode(node.props.children)
  }
  return ""
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const child = Children.toArray(children)[0]
  const className = isValidElement<{ className?: string }>(child)
    ? child.props.className
    : undefined
  const language = className?.match(/language-([\w-]+)/)?.[1] ?? "code"

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(textFromNode(children).trimEnd())
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="code-block">
      <div className="code-block__header">
        <span>{language}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={copied ? "Copied" : "Copy code"}
                onClick={copy}
              />
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </TooltipTrigger>
          <TooltipContent portalClassName="agentchats-transcript">{copied ? "Copied" : "Copy code"}</TooltipContent>
        </Tooltip>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

type MarkdownNode = {
  type: string
  value?: string
  lang?: string | null
  meta?: string | null
  children?: MarkdownNode[]
}

const metadataAssignment = /(?:^|\s)[\w.-]+=(?:"[^"]*"|'[^']*'|\S+)/
const sentencePunctuation = /[.!?](?:\s|$)/
const commonLanguageRegistry = createLowlight(common)

/** Recover prose accidentally placed on an otherwise empty opening fence. */
function remarkRecoverEmptyFenceInfo() {
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (!parent.children) return
      parent.children = parent.children.map((node) => {
        const meta = node.meta?.trim()
        if (
          node.type === "code" &&
          node.value === "" &&
          node.lang &&
          meta &&
          !commonLanguageRegistry.registered(node.lang) &&
          sentencePunctuation.test(meta) &&
          !metadataAssignment.test(meta)
        ) {
          return {
            ...node,
            lang: null,
            meta: null,
            value: `${node.lang} ${meta}`,
          }
        }
        visit(node)
        return node
      })
    }
    visit(tree)
  }
}

const remarkPlugins = [remarkGfm, remarkRecoverEmptyFenceInfo]
const rehypePlugins = [rehypeHighlight]
const markdownComponents: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ children, node: _node, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
}: {
  content: string
}) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
