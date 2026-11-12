/** "Get code": the current playground request as an API call, with a way to the API keys page. */
import { useState } from "react";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { CornerDownLeft } from "lucide-react";
import { LANGS, type Lang } from "../../../../entities/snippets";

export function GetCode(props: {
  open: boolean;
  onClose: () => void;
  code: (lang: Lang) => string;
  scopeName: string;
  canManageKeys: boolean;
  openKeys: () => void;
}) {
  const [lang, setLang] = useState<Lang>("curl");
  const language = LANGS.find((option) => option.id === lang)!.language;
  return (
    <Dialog isOpen={props.open} onOpenChange={(open) => !open && props.onClose()} width={760} purpose="info">
      <DialogHeader
        title="Get code"
        subtitle="The current playground request as an API call. It reads your key from NALAR_API_KEY."
      />
      <div className="dialog-body">
        <TabList value={lang} onChange={(value) => setLang(value as Lang)} size="sm" hasDivider>
          {LANGS.map((option) => (
            <Tab key={option.id} value={option.id} label={option.label} />
          ))}
        </TabList>
        <CodeBlock code={props.code(lang)} language={language} hasCopyButton maxHeight={380} size="sm" />
        <div className="callout">
          <CornerDownLeft size={15} />
          <span className="small">
            Playground runs use your console session. Services use an API key with the{" "}
            <span className="mono">{props.scopeName}</span> scope.
            {props.canManageKeys ? " " : " Ask an owner or developer on your tenant for one."}
          </span>
          {props.canManageKeys && (
            <button className="btn sm" onClick={props.openKeys}>
              Create a key
            </button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
