import { Fragment, type ReactNode } from "react";

interface MarkdownViewProps {
  content: string;
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={`${match.index}-b`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(<code key={`${match.index}-c`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(<em key={`${match.index}-i`}>{token.slice(1, -1)}</em>);
    } else {
      nodes.push(token);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

export function MarkdownView({ content }: MarkdownViewProps): JSX.Element {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraphBuffer: string[] = [];
  let listBuffer: { type: "ul" | "ol"; items: string[] } | null = null;
  let codeFenceBuffer: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraphBuffer.length === 0) {
      return;
    }
    const text = paragraphBuffer.join(" ").trim();
    if (text) {
      blocks.push(
        <p key={`p-${blocks.length}`}>
          {renderInline(text)}
        </p>,
      );
    }
    paragraphBuffer = [];
  };

  const flushList = (): void => {
    if (!listBuffer || listBuffer.items.length === 0) {
      listBuffer = null;
      return;
    }
    const items = listBuffer.items.map((item, index) => (
      <li key={`li-${blocks.length}-${index}`}>{renderInline(item)}</li>
    ));
    blocks.push(
      listBuffer.type === "ol" ? (
        <ol key={`ol-${blocks.length}`}>{items}</ol>
      ) : (
        <ul key={`ul-${blocks.length}`}>{items}</ul>
      ),
    );
    listBuffer = null;
  };

  const flushCodeFence = (): void => {
    if (!codeFenceBuffer) {
      return;
    }
    blocks.push(
      <pre key={`code-${blocks.length}`}>
        <code>{codeFenceBuffer.join("\n")}</code>
      </pre>,
    );
    codeFenceBuffer = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      if (codeFenceBuffer) {
        flushCodeFence();
      } else {
        codeFenceBuffer = [];
      }
      continue;
    }

    if (codeFenceBuffer) {
      codeFenceBuffer.push(rawLine);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const Tag = (`h${Math.min(level, 6)}` as keyof JSX.IntrinsicElements);
      blocks.push(<Tag key={`h-${blocks.length}`}>{renderInline(text)}</Tag>);
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      if (!listBuffer || listBuffer.type !== "ol") {
        flushList();
        listBuffer = { type: "ol", items: [] };
      }
      listBuffer.items.push(orderedMatch[1]);
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (unorderedMatch) {
      flushParagraph();
      if (!listBuffer || listBuffer.type !== "ul") {
        flushList();
        listBuffer = { type: "ul", items: [] };
      }
      listBuffer.items.push(unorderedMatch[1]);
      continue;
    }

    flushList();
    paragraphBuffer.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushCodeFence();

  return <div className="markdown-view">{blocks.map((block, index) => <Fragment key={index}>{block}</Fragment>)}</div>;
}

