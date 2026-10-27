import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { useEffect, useRef, useState, useCallback } from "react";
import MonacoEditor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { toast } from "sonner";
import invariant from "tiny-invariant";
import type { TextRecord } from "~/utils/text.server";
import {
  getText,
  getTextByTextId,
  updateText,
  updateTextByTextId,
  deleteText,
  saveTextUndo,
} from "~/utils/text.server";
import { getUserSession, getVisitorSession } from "~/utils/session.server";
import { TEXT_MAX_SIZE, FIELD_MAX_SIZE } from "~/utils/constants";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: "/css/app.css" },
  { rel: "stylesheet", href: "/css/text-editor.css" },
];

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  invariant(params.textId, "Missing textId param");
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const userId = user?.sub || visitor?.sub;

  // Get text from user's collection first to determine ownership
  let userText = null;
  let isOwner = false;

  if (userId) {
    userText = await getText(userId, params.textId);
    isOwner = !!userText;
  }

  // Get the text content (from user collection or search globally)
  let text = userText;
  if (!text) {
    text = await getTextByTextId(params.textId);
  }

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
  const now = new Date().toISOString();
  const updatedText = {
    ...text,
    lastAccessedAt: now,
    accessCount: (text.accessCount || 0) + 1,
    // Explicitly do NOT update lastEditedAt here
  };

  // Update access statistics using the appropriate method
  try {
    if (userId) {
      try {
        await updateText(userId, params.textId, updatedText);
      } catch {
        // If user is not owner, use global update
        await updateTextByTextId(params.textId, updatedText);
      }
    } else {
      // Update globally by textId when user is logged out
      await updateTextByTextId(params.textId, updatedText);
    }
  } catch (error) {
    // If update fails, just continue with the text data
    console.log("Failed to update access statistics:", error);
  }

  // Re-fetch the latest text data to ensure updateCount is current
  let latestText: TextRecord & { owner: boolean } = {
    ...updatedText,
    owner: isOwner,
  };
  try {
    if (userId) {
      const fetched = await getText(userId, params.textId);
      if (fetched) {
        latestText = { ...fetched, owner: isOwner };
      } else {
        const globalFetched = await getTextByTextId(params.textId);
        if (globalFetched) {
          latestText = { ...globalFetched, owner: isOwner };
        }
      }
    } else {
      const globalFetched = await getTextByTextId(params.textId);
      if (globalFetched) {
        latestText = { ...globalFetched, owner: false };
      }
    }
  } catch (error) {
    console.log("Failed to re-fetch latest text:", error);
  }

  return json({ text: latestText });
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

    // Check content size
    const contentSize = new TextEncoder().encode(content).length;
    if (contentSize > TEXT_MAX_SIZE) {
      return json({
        success: false,
        message: `Content size (${(contentSize / 1024 / 1024).toFixed(
          2,
        )}MB) exceeds the maximum limit of ${(
          TEXT_MAX_SIZE /
          1024 /
          1024
        ).toFixed(0)}MB`,
      });
    }

    // Check field sizes
    if (title && new TextEncoder().encode(title).length > FIELD_MAX_SIZE) {
      return json({
        success: false,
        message: `Title exceeds the maximum limit of ${(
          FIELD_MAX_SIZE / 1024
        ).toFixed(1)}KB`,
      });
    }

    const now = new Date().toISOString();

    // Try to update with userId first, if userId exists
    if (userId) {
      try {
        await updateText(userId, params.textId, {
          content,
          language,
          title,
          updateCount: updateCount
            ? parseInt(updateCount as string)
            : undefined,
          lastEditedAt: now,
        });
      } catch (error) {
        // If updateText fails (user is not owner), use global update instead
        console.log("User is not owner, using global update:", error);
        try {
          await updateTextByTextId(params.textId, {
            content,
            language,
            title,
            updateCount: updateCount
              ? parseInt(updateCount as string)
              : undefined,
            lastEditedAt: now,
          });
        } catch (globalError) {
          console.error("Failed to update text globally:", globalError);
          return json({
            success: false,
            message: "Failed to save text",
          });
        }
      }
    } else {
      // Otherwise, update globally by textId
      await updateTextByTextId(params.textId, {
        content,
        language,
        title,
        updateCount: updateCount ? parseInt(updateCount as string) : undefined,
        lastEditedAt: now,
      });
    }

    return json({
      success: true,
      message: "Saved successfully",
    });
  }

  if (intent === "delete") {
    if (!userId) {
      return json(
        { success: false, message: "Only the owner can delete this text" },
        { status: 403 },
      );
    }

    // Ownership is the current session's collection membership, not a saved
    // display flag or knowledge of the public sharing URL.
    const text = await getText(userId, params.textId);
    if (!text) {
      return json(
        { success: false, message: "Only the owner can delete this text" },
        { status: 403 },
      );
    }

    // Save undo then delete
    await saveTextUndo(userId, params.textId, text);
    await deleteText(userId, params.textId);
    return redirect(
      `/?message=Deleted&undoId=${encodeURIComponent(
        params.textId,
      )}&undoType=text`,
    );
  }

  return json({ success: false, message: "Unknown intent" });
};

export default function TextEditor() {
  const submit = useSubmit();
  const navigation = useNavigation();
  const { text } = useLoaderData<typeof loader>();
  const [content, setContent] = useState(
    text.content ?? "# Welcome\n\nStart typing...",
  );
  const [language, setLanguage] = useState(text?.language || "markdown");
  const [title, setTitle] = useState(
    text?.title || text?.token || "Untitled Text",
  );

  // Track last update to prevent overwriting local edits
  const lastUpdateCountRef = useRef(text?.updateCount || 0);
  const currentTextIdRef = useRef(text.id);

  // Update content, title, and language when text changes (from server)
  // But only if it's a new update (not the same version)
  useEffect(() => {
    if (text) {
      const currentUpdateCount = text.updateCount || 0;
      const lastUpdateCount = lastUpdateCountRef.current;

      // Switching documents must reset the editor even if its revision is lower.
      // For the same document, preserve local edits until a newer version arrives.
      if (
        text.id !== currentTextIdRef.current ||
        currentUpdateCount > lastUpdateCount
      ) {
        setContent(text.content ?? "# Welcome\n\nStart typing...");
        setLanguage(text.language || "markdown");
        setTitle(text.title || text.token || "Untitled Text");
        currentTextIdRef.current = text.id;
        lastUpdateCountRef.current = currentUpdateCount;
      }
    }
  }, [text]);
  const [isSaving, setIsSaving] = useState(false);
  const actionData = useActionData<ActionData>();
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("content", content);
    formData.append("language", language);
    formData.append("title", title);
    formData.append("updateCount", String((text.updateCount || 0) + 1));
    submit(formData, { method: "post", fetcherKey: "save-text" });
  }, [content, language, title, text.updateCount, submit]);

  const handleDelete = useCallback(() => {
    toast.warning("Are you sure? This text will be deleted.", {
      action: {
        label: "Yes, delete it!",
        onClick: () => {
          const formData = new FormData();
          formData.append("intent", "delete");
          submit(formData, { method: "post" });
        },
      },
      cancel: { label: "Cancel", onClick: () => {} },
    });
  }, [submit]);

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
          formData.append("language", language);
          formData.append("title", title);
          formData.append("updateCount", String((text.updateCount || 0) + 1));
          submit(formData, { method: "post", fetcherKey: "save-text" });
          return false;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [content, language, title, text.updateCount, submit]);

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
          <button
            onClick={handleDelete}
            disabled={text?.owner === false}
            style={{
              color: text?.owner === false ? "#ccc" : "#f44250",
              cursor: text?.owner === false ? "not-allowed" : "pointer",
              opacity: text?.owner === false ? 0.5 : 1,
            }}
          >
            Delete
          </button>
        </div>
      </div>

      <div id="text-editor-wrapper">
        {typeof window !== "undefined" ? (
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
