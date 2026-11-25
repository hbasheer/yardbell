// Adapted from Orca's Monaco setup (MIT, Lovecast Inc.), see THIRD_PARTY_NOTICES.md
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { typescript as monacoTS } from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  }
}

// The worker cannot see the project's imports, so its diagnostics would only be noise.
const quiet = { noSemanticValidation: true, noSuggestionDiagnostics: true, noSyntaxValidation: true }
monacoTS.typescriptDefaults.setDiagnosticsOptions(quiet)
monacoTS.javascriptDefaults.setDiagnosticsOptions(quiet)
monacoTS.typescriptDefaults.setCompilerOptions({ ...monacoTS.typescriptDefaults.getCompilerOptions(), jsx: monacoTS.JsxEmit.Preserve })

monaco.editor.defineTheme('yardbell-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#1e1e1e' } })
monaco.editor.defineTheme('yardbell-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ffffff' } })

loader.config({ monaco })

export { monaco }

export function languageOf(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() || ''
  const ext = name.includes('.') ? `.${name.split('.').pop()}` : ''
  for (const l of monaco.languages.getLanguages()) if (l.filenames?.some((f) => f.toLowerCase() === name)) return l.id
  for (const l of monaco.languages.getLanguages()) if (ext && l.extensions?.includes(ext)) return l.id
  return 'plaintext'
}

export const EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  fontFamily: "'SF Mono', SFMono-Regular, ui-monospace, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 13,
  lineNumbers: 'on',
  renderLineHighlight: 'line',
  scrollBeyondLastLine: false,
  minimap: { enabled: false },
  smoothScrolling: true,
  cursorSmoothCaretAnimation: 'off',
  padding: { top: 0 },
  tabSize: 2,
  fixedOverflowWidgets: true
}
