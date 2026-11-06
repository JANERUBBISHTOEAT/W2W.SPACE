import {
  type ActionFunctionArgs,
  type LinksFunction,
  type LoaderFunctionArgs,
  data,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useNavigate,
  useSubmit,
} from "react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { toast } from "sonner";
import { getTextByTextId, updateTextByTextId, accessText } from "~/utils/text.server";
import { ShareValidationError } from "~/utils/share.server";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: "/css/app.css" },
  { rel: "stylesheet", href: "/css/text-editor.css" },
];

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const text = params.textId ? await getTextByTextId(params.textId) : null;
  if (!text) return redirect("/?message=Text+Not+Found");
  return data({ text }, { headers: { "Cache-Control": "no-store" } });
};

interface ActionData { success?: boolean; message?: string }

export const action = async ({ params, request }: ActionFunctionArgs) => {
  if (!params.textId) return data({ success: false, message: "Text not found" }, { status: 404 });
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "access") {
      const text = await accessText(params.textId);
      return Response.json({ success: !!text }, { status: text ? 200 : 404 });
    }
    if (intent === "save") {
      const content = form.get("content");
      if (typeof content !== "string") throw new ShareValidationError("Text content is required");
      const text = await updateTextByTextId(params.textId, { content });
      return data(text
        ? { success: true, message: "Saved successfully" }
        : { success: false, message: "This text share has expired" }, { status: text ? 200 : 404 });
    }
    return data({ success: false, message: "Unknown intent" }, { status: 400 });
  } catch (error) {
    if (error instanceof ShareValidationError) return data({ success: false, message: error.message }, { status: 400 });
    throw error;
  }
};

export default function TextEditor() {
  const submit = useSubmit();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    setHasMounted(true);
  }, []);
  const { text } = useLoaderData<typeof loader>();
  const [content, setContent] = useState(
    text.content ?? "# Welcome\n\nStart typing...",
  );
  // Editor language is a temporary viewing preference, not saved document data.
  const [language, setLanguage] = useState("markdown");
  const title = text.content.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").slice(0, 80) || "Untitled Text";
  const currentTextIdRef = useRef(text.id);
  useEffect(() => {
    if (text.id !== currentTextIdRef.current) {
      setContent(text.content);
      setLanguage("markdown");
      currentTextIdRef.current = text.id;
    }
  }, [text]);
  useEffect(() => {
    // Loaders can run for revalidation and prefetch. Only a mounted document
    // counts as a reader; background loader requests never extend its TTL.
    const controller = new AbortController();
    void fetch(`/texts/${text.id}`, {
      method: "POST",
      body: new URLSearchParams({ intent: "access" }),
      signal: controller.signal,
    }).then((response) => {
      if (!response.ok) toast.error("This text share has expired");
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error("Could not refresh this text share");
    });
    return () => controller.abort();
  }, [text.id]);
  const [isSaving, setIsSaving] = useState(false);
  const actionData = useActionData<ActionData>();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("content", content);
    submit(formData, { method: "post", fetcherKey: "save-text" });
  }, [content, submit]);

  const shownActionDataRef = useRef<typeof actionData>(undefined);
  useEffect(() => {
    if (!actionData) return;
    if (shownActionDataRef.current === actionData) return;
    shownActionDataRef.current = actionData;
    setIsSaving(false);
    if (actionData.success) {
      const msg = actionData.message || "Saved successfully";
      const token = text?.token;
      toast.success(msg, {
        ...(token
          ? {
              action: {
                label: "Copy token",
                onClick: () => {
                  navigator.clipboard.writeText(token).then(
                    () => toast.success("Copied!"),
                    () => toast.error("Failed to copy"),
                  );
                },
              },
            }
          : {}),
      });
    } else if (actionData.message) {
      toast.error(actionData.message);
    }
  }, [actionData, text?.token]);

  const handleEditorDidMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined) {
      setContent(value);
    }
  };

  // Handle keyboard shortcuts globally to prevent browser save dialog
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        // Only prevent if focused on the page (not in input fields outside editor)
        const target = e.target;
        const isTitleInput =
          target instanceof HTMLInputElement &&
          target.getAttribute("placeholder") === "Untitled Text";
        const isTokenInput =
          target instanceof HTMLElement &&
          target.getAttribute("aria-label") === "Token";

        // Don't handle if typing in title/token inputs
        if (!isTitleInput && !isTokenInput) {
          e.preventDefault();
          e.stopPropagation();
          console.log("Ctrl+S pressed, saving from editor");

          // Get latest content directly from Monaco editor instance
          const currentContent = editorRef.current?.getValue() ?? content;

          setIsSaving(true);
          const formData = new FormData();
          formData.append("intent", "save");
          formData.append("content", currentContent); // Use content from editor
                            submit(formData, { method: "post", fetcherKey: "save-text" });
          return false;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [content, submit]);

  const copyToken = async () => {
    if (text?.token) {
      await navigator.clipboard.writeText(text.token);
      toast.success("Token copied to clipboard");
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
              readOnly
              aria-label="Text title from content"
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
          <button onClick={() => navigate("/")} style={{ position: "relative", color: "#f44250", cursor: "pointer", opacity: 1 }}>
            <span aria-hidden style={{ visibility: "hidden" }}>Delete</span>
            <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>Close</span>
          </button>
        </div>
      </div>

      <div id="text-editor-wrapper">
        {hasMounted ? (
          <MonacoEditor
            height="100%"
            language={language}
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
