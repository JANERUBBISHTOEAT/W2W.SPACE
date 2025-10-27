import type { LinksFunction } from "@remix-run/node";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { useEffect, useRef, useState, useCallback } from "react";
import MonacoEditor from "@monaco-editor/react";
import toastr from "toastr";
import invariant from "tiny-invariant";
import type { TextRecord } from "~/utils/text.server";
import { getText, updateText } from "~/utils/text.server";
import { getUserSession, getVisitorSession } from "~/utils/session.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: "/css/app.css" },
  { rel: "stylesheet", href: "/css/text-editor.css" },
];

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  invariant(params.textId, "Missing textId param");
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const userId = user?.sub || visitor?.sub;
  const text = await getText(userId, params.textId);
  if (!text) {
    return redirect("/?message=Text+Not+Found");
  }

  // Check if text is marked as deleted in unifiedTokenMap
  if (text.token) {
    const HashMap = (await import("~/utils/hashmap.server")).default;
    const tokenStatus = await HashMap.getBoth(text.token);
    if (tokenStatus && tokenStatus.status === "deleted") {
      return redirect(`/deleted`);
    }
  }

  // Update access statistics (DO NOT update lastEditedAt on access)
  const { updateText } = await import("~/utils/text.server");
  const now = new Date().toISOString();
  const updatedText = {
    ...text,
    lastAccessedAt: now,
    accessCount: (text.accessCount || 0) + 1,
    // Explicitly do NOT update lastEditedAt here
  };
  await updateText(userId, params.textId, updatedText);

  return json({ text: updatedText });
};

interface ActionData {
  success?: boolean;
  message?: string;
}

export const action = async ({ params, request }: ActionFunctionArgs) => {
  invariant(params.textId, "Missing textId param");
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const userId = user?.sub || visitor?.sub;

  if (intent === "save") {
    const content = formData.get("content") as string;
    const language = formData.get("language") as string;
    const title = formData.get("title") as string;
    const updateCount = formData.get("updateCount");

    const now = new Date().toISOString();
    await updateText(userId, params.textId, {
      content,
      language,
      title,
      updateCount: updateCount ? parseInt(updateCount as string) : undefined,
      lastEditedAt: now,
    });

    return json({
      success: true,
      message: "Saved successfully",
    });
  }

  return json({ success: false, message: "Unknown intent" });
};

export default function TextEditor() {
  const submit = useSubmit();
  const navigation = useNavigation();
  const { text } = useLoaderData<typeof loader>();
  const [content, setContent] = useState(
    text?.content || "# Welcome\n\nStart typing..."
  );
  const [language, setLanguage] = useState(text?.language || "markdown");
  const [title, setTitle] = useState(
    text?.title || text?.token || "Untitled Text"
  );

  // Update content, title, and language when text changes (from server)
  useEffect(() => {
    if (text) {
      setContent(text.content || "# Welcome\n\nStart typing...");
      setLanguage(text.language || "markdown");
      setTitle(text.title || text.token || "Untitled Text");
    }
  }, [text]);
  const [isSaving, setIsSaving] = useState(false);
  const actionData = useActionData<ActionData>();
  const editorRef = useRef<unknown>(null);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("content", content);
    formData.append("language", language);
    formData.append("title", title);
    formData.append("updateCount", String((text.updateCount || 0) + 1));
    submit(formData, { method: "post" });
  }, [content, language, title, text.updateCount, submit]);

  useEffect(() => {
    if (actionData?.success) {
      setIsSaving(false);
      toastr.success(actionData.message || "Saved successfully");
    }
  }, [actionData]);

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    try {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        handleSave();
      });
    } catch (error) {
      console.error("Error setting up editor:", error);
    }
  };

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined) {
      setContent(value);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [content, language, title, handleSave]);

  const copyToken = async () => {
    if (text?.token) {
      await navigator.clipboard.writeText(text.token);
      toastr.success("Token copied to clipboard");
    }
  };

  const languages = [
    { value: "markdown", label: "Markdown" },
    { value: "javascript", label: "JavaScript" },
    { value: "typescript", label: "TypeScript" },
    { value: "python", label: "Python" },
    { value: "java", label: "Java" },
    { value: "cpp", label: "C++" },
    { value: "csharp", label: "C#" },
    { value: "html", label: "HTML" },
    { value: "css", label: "CSS" },
    { value: "json", label: "JSON" },
    { value: "sql", label: "SQL" },
    { value: "plaintext", label: "Plain Text" },
  ];

  return (
    <div id="text-editor-container">
      <div id="text-editor-header">
        <div id="text-editor-header-left">
          <i
            className="fas fa-file-code fa-2x"
            style={{ color: "#818181" }}
          ></i>
          <p>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled Text"
            />
            <input
              aria-label="Token"
              name="token"
              value={text?.token || ""}
              placeholder="Token"
              type="text"
              disabled
              readOnly
            />
            <button id="copy-token" type="button" onClick={copyToken}>
              Copy
            </button>
          </p>
        </div>
        <div id="text-editor-header-right">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            title="Select programming language"
            aria-label="Select programming language"
          >
            {languages.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
          <button
            onClick={handleSave}
            disabled={isSaving || navigation.state === "submitting"}
          >
            {isSaving || navigation.state === "submitting"
              ? "Saving..."
              : "Save"}
          </button>
        </div>
      </div>

      <div id="text-editor-wrapper">
        {typeof window !== "undefined" ? (
          <MonacoEditor
            height="100%"
            defaultLanguage={language}
            value={content}
            theme="vs"
            onChange={handleEditorChange}
            onMount={handleEditorDidMount}
            loading={<div className="editor-loading">Loading Editor...</div>}
            options={{
              fontSize: 14,
              minimap: { enabled: true },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              tabCompletion: "on",
              multiCursorModifier: "ctrlCmd",
              formatOnPaste: true,
              formatOnType: true,
              quickSuggestions: true,
              suggestOnTriggerCharacters: true,
              acceptSuggestionOnCommitCharacter: true,
              acceptSuggestionOnEnter: "on",
              lineNumbers: "on",
            }}
          />
        ) : null}
      </div>

      <div id="text-editor-footer">
        Total Characters: {content.length} | Lines: {content.split("\n").length}
      </div>
    </div>
  );
}
