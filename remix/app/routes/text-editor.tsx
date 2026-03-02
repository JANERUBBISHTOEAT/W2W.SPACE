import type { LinksFunction } from "@remix-run/node";
import { ActionFunctionArgs, json } from "@remix-run/node";
import { useActionData, useNavigation, useSubmit } from "@remix-run/react";
import { useEffect, useRef, useState, useCallback } from "react";
import MonacoEditor from "@monaco-editor/react";
import { toast } from "sonner";

interface ActionData {
  success?: boolean;
  message?: string;
  content?: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const content = formData.get("content") as string;

  if (intent === "save") {
    console.log("Saving content:", content);
    return json({
      success: true,
      message: "Content saved successfully",
      content: content,
    });
  }

  return json({ success: false, message: "Unknown intent" });
};

export default function TextEditor() {
  const submit = useSubmit();
  const navigation = useNavigation();
  const [content, setContent] = useState(
    "# Welcome to Text Editor\n\nStart typing...",
  );
  const [isSaving, setIsSaving] = useState(false);
  const actionData = useActionData<ActionData>();
  const editorRef = useRef<unknown>(null);

  const handleSave = useCallback(() => {
    setIsSaving(true);
    const formData = new FormData();
    formData.append("intent", "save");
    formData.append("content", content);
    submit(formData, { method: "post" });
  }, [content, submit]);

  const shownActionDataRef = useRef<typeof actionData>(null);
  useEffect(() => {
    if (!actionData?.success) return;
    if (shownActionDataRef.current === actionData) return;
    shownActionDataRef.current = actionData;
    setIsSaving(false);
    toast.success(actionData.message || "Saved successfully");
  }, [actionData]);

  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor;
    try {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        handleSave();
      });

      monaco.editor.defineTheme("customTheme", {
        base: "vs",
        inherit: true,
        rules: [],
        colors: {
          "editor.background": "#ffffff",
        },
      });
      monaco.editor.setTheme("customTheme");
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
  }, [content, handleSave]);

  return (
    <div id="text-editor-container">
      <div id="text-editor-header">
        <h2>Text Editor</h2>
        <button
          onClick={handleSave}
          disabled={isSaving || navigation.state === "submitting"}
        >
          {isSaving || navigation.state === "submitting"
            ? "Saving..."
            : "Save (Ctrl+S)"}
        </button>
      </div>

      <div id="text-editor-wrapper">
        {typeof window !== "undefined" ? (
          <MonacoEditor
            height="100%"
            defaultLanguage="markdown"
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
