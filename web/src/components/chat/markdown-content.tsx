import { Children, isValidElement, useState, type ReactNode } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"
import ReactMarkdown from "react-markdown"
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
          <TooltipContent>{copied ? "Copied" : "Copy code"}</TooltipContent>
        </Tooltip>
      </div>
      <pre>{children}</pre>
    </div>
  )
}

export function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
