import type { FormEvent } from "react";

import { useLayoutEffect, useRef, useState } from "react";

import { Alert, AlertDescription } from "@/src/components/ui/alert";
import { Button } from "@/src/components/ui/button";
import { Card } from "@/src/components/ui/card";
import { Checkbox } from "@/src/components/ui/checkbox";
import { Input } from "@/src/components/ui/input";
import { Label } from "@/src/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/src/components/ui/native-select";

import type { ModelProfileDetails, Provider, PublicModelProfile, PublicModelSettings as Settings } from "../../src/models/profiles.ts";
import type { SettingsCommand } from "../../src/models/worker-protocol.ts";

import {
  createProfileDetails,
  hostPermission,
  modelEndpoint,

} from "../../src/models/profiles.ts";
import { updateModelSettings } from "../../src/models/worker-client.ts";

const providers: Record<Provider, string> = {
  compatible: "OpenAI-compatible (local or hosted)",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

type HeaderEdit = { name: string; value: string; savedIndex?: number };
type ProfileEdit = ModelProfileDetails & { keySaved: boolean; key?: string; revision?: string; headers: HeaderEdit[] };

function editProfile(saved?: PublicModelProfile): ProfileEdit {
  if (!saved)
    return { ...createProfileDetails(), keySaved: false, headers: [] };
  const { headerNames, ...profile } = saved;
  return { ...profile, headers: headerNames.map((name, savedIndex) => ({ name, savedIndex, value: "" })) };
}

export function ModelSettings({ settings, onSave }: { settings: Settings; onSave: (settings: Settings) => void }) {
  const [profile, setProfile] = useState<ProfileEdit>();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const headers = profile?.headers ?? [];
  const keySaved = profile?.keySaved ?? false;
  const key = profile?.key;
  const savedProfile = settings.profiles.find(({ id }) => id === profile?.id);
  const editorOpen = profile !== undefined;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (editorOpen && !dialog?.open)
      dialog?.showModal();
    else if (!editorOpen)
      dialog?.close();
  }, [editorOpen]);

  function openEditor(saved?: PublicModelProfile) {
    setError("");
    setNotice("");
    setProfile(editProfile(saved));
  }

  function closeEditor() {
    setError("");
    setProfile(undefined);
  }

  function change<K extends keyof ProfileEdit>(key: K, value: ProfileEdit[K]) {
    setProfile((current) => {
      if (!current)
        return current;
      const next = { ...current, [key]: value };
      const changedProvider = key === "provider" && value !== current.provider;
      const changedSavedEndpoint = key === "endpoint" && value !== current.endpoint && savedProfile !== undefined;
      if (changedProvider || changedSavedEndpoint) {
        next.keySaved = false;
        next.key = "";
        next.headers = [];
      }
      return next;
    });
    setError("");
    setNotice("");
  }

  function changeHeader(index: number, update: (header: HeaderEdit) => HeaderEdit) {
    change("headers", headers.map((header, position) => position === index ? update(header) : header));
  }

  async function submit(command: SettingsCommand) {
    const next = await updateModelSettings(command);
    onSave(next);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile)
      return;
    setError("");
    setNotice("");
    setSaving(true);
    try {
      const { headers, keySaved, key, ...details } = profile;
      const trimmedKey = key?.trim() ?? "";
      const keyUpdate = key === "" || trimmedKey !== "" ? trimmedKey : undefined;
      if (!details.label.trim() || !details.model.trim())
        throw new Error("Enter a profile name and a model ID.");
      if (details.provider !== "compatible" && !trimmedKey && !keySaved && savedProfile?.provider !== details.provider) {
        throw new Error("Enter an API key for this provider.");
      }
      const endpoint = modelEndpoint(details);
      const granted = await chrome.permissions.request({ origins: [hostPermission(endpoint)] });
      if (!granted)
        throw new Error("Allow access to the model endpoint to save this profile.");
      await submit({ type: "save-profile", profile: {
        ...details,
        ...(keyUpdate === undefined ? {} : { key: keyUpdate }),
        customHeaders: headers.map(({ name, value, savedIndex }) =>
          savedIndex !== undefined && value === "" ? { name, savedIndex } : { name, value }),
      } });
      closeEditor();
      setNotice("Profile saved.");
    }
    catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not save the profile.");
    }
    finally {
      setSaving(false);
    }
  }

  async function assign(role: "main" | "system", id: string) {
    setSaving(true);
    try {
      await submit({ type: "assign-profile", role, id });
    }
    catch {
      setError("Could not save the model assignment.");
    }
    finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!savedProfile || !profile || profile.revision === undefined)
      return;
    setSaving(true);
    try {
      await submit({ type: "remove-profile", id: profile.id, revision: profile.revision });
      closeEditor();
      setNotice("Profile removed.");
    }
    catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not remove the profile.");
    }
    finally {
      setSaving(false);
    }
  }

  let destination = "your configured endpoint";
  try {
    if (profile)
      destination = modelEndpoint(profile).origin;
  }
  catch { /* A URL is validated on save. */ }

  return (
    <Card
      role="region"
      className="control-panel"
      aria-labelledby="models-heading"
    >
      <h2 id="models-heading">Model settings</h2>
      {settings.profiles.length > 0 && (
        <div className="form-grid">
          <div className="field">
            <Label htmlFor="explanation-model">Explanation model</Label>
            <NativeSelect
              id="explanation-model"
              disabled={saving}
              value={settings.main}
              onChange={event => void assign("main", event.target.value)}
            >
              {settings.profiles.map(({ id, label }) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <div className="field">
            <Label htmlFor="system-model">System 1 model</Label>
            <NativeSelect
              id="system-model"
              disabled={saving}
              value={settings.system}
              onChange={event => void assign("system", event.target.value)}
            >
              {settings.profiles.map(({ id, label }) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
            </NativeSelect>
          </div>
        </div>
      )}
      <section className="form-grid" aria-labelledby="saved-profiles-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="saved-profiles-heading">Saved profiles</h3>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-haspopup="dialog"
            disabled={saving}
            onClick={() => openEditor()}
          >
            Add profile
          </Button>
        </div>
        {settings.profiles.length > 0 && (
          <ul className="model-profile-list">
            {settings.profiles.map(saved => (
              <li key={saved.id}>
                <div>
                  <strong>{saved.label}</strong>
                  <small>{saved.model}</small>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Edit ${saved.label}`}
                  aria-haspopup="dialog"
                  disabled={saving}
                  onClick={() => openEditor(saved)}
                >
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <dialog
        ref={dialogRef}
        className="model-profile-dialog"
        aria-labelledby="model-profile-editor-heading"
        onCancel={(event) => {
          event.preventDefault();
          if (!saving)
            closeEditor();
        }}
      >
        {profile && (
          <div className="form-grid">
            <h2 id="model-profile-editor-heading">{savedProfile ? "Edit profile" : "Add profile"}</h2>
            <form onSubmit={event => void save(event)}>
              <fieldset className="form-grid" disabled={saving}>
                <div className="field">
                  <Label htmlFor="profile-name">Profile name</Label>
                  <Input
                    id="profile-name"
                    required
                    placeholder="A name for this profile"
                    value={profile.label}
                    onChange={event => change("label", event.target.value)}
                  />
                </div>
                <div className="field">
                  <Label htmlFor="provider">Provider</Label>
                  <NativeSelect
                    id="provider"
                    value={profile.provider}
                    onChange={event => change("provider", event.target.value as Provider)}
                  >
                    {Object.entries(providers).map(([id, label]) => <NativeSelectOption key={id} value={id}>{label}</NativeSelectOption>)}
                  </NativeSelect>
                </div>
                {profile.provider === "compatible" && (
                  <div className="field">
                    <Label htmlFor="base-url">Base URL</Label>
                    <Input
                      id="base-url"
                      required
                      type="url"
                      placeholder="http://localhost:8080/v1"
                      value={profile.endpoint}
                      onChange={event => change("endpoint", event.target.value)}
                    />
                  </div>
                )}
                <div className="field">
                  <Label htmlFor="model-id">Model ID</Label>
                  <Input
                    id="model-id"
                    required
                    placeholder="Model ID from your provider"
                    value={profile.model}
                    onChange={event => change("model", event.target.value)}
                  />
                </div>
                <div className="field">
                  <Label htmlFor="api-key">
                    API key
                    {profile.provider === "compatible" ? " (optional)" : ""}
                  </Label>
                  <Input
                    id="api-key"
                    type="password"
                    autoComplete="off"
                    value={key ?? ""}
                    placeholder={keySaved ? "Enter a replacement key" : undefined}
                    onChange={event => change("key", event.target.value || (keySaved ? undefined : ""))}
                  />
                  {keySaved && (
                    <div className="button-row">
                      <span className="muted">{key === "" ? "Key will be removed on save" : "Key saved"}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => change("key", key === "" ? undefined : "")}
                      >
                        {key === "" ? "Keep saved key" : "Remove key"}
                      </Button>
                    </div>
                  )}
                </div>
                <fieldset className="form-grid">
                  <legend className="text-sm font-medium">Custom headers</legend>
                  {headers.map(({ name, value, savedIndex }, index) => (
                    <div className="field" key={index}>
                      <Label htmlFor={`header-name-${index}`}>Header name</Label>
                      <Input
                        id={`header-name-${index}`}
                        placeholder="X-API-Key"
                        autoComplete="off"
                        spellCheck={false}
                        required
                        value={name}
                        onChange={event => changeHeader(index, header => ({ ...header, name: event.target.value, savedIndex: undefined }))}
                      />
                      <Label htmlFor={`header-value-${index}`}>{savedIndex === undefined ? "Header value" : "Header value saved"}</Label>
                      <Input
                        id={`header-value-${index}`}
                        type="password"
                        autoComplete="off"
                        value={value}
                        placeholder={savedIndex === undefined ? undefined : "Enter a replacement value"}
                        onChange={event => changeHeader(index, header => ({ ...header, value: event.target.value }))}
                      />
                      <div className="button-row">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove header ${name || index + 1}`}
                          onClick={() => change("headers", headers.filter((_, position) => position !== index))}
                        >
                          Remove header
                        </Button>
                      </div>
                    </div>
                  ))}
                  <div className="button-row">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => change("headers", [...headers, { name: "", value: "" }])}
                    >
                      Add header
                    </Button>
                  </div>
                </fieldset>
                <details className="grid gap-2">
                  <summary className="cursor-pointer">Advanced model options</summary>
                  <div className="checkbox-row mt-2">
                    <Checkbox
                      id="tool-calls"
                      checked={profile.toolCalls}
                      onCheckedChange={checked => change("toolCalls", checked)}
                    />
                    <Label htmlFor="tool-calls">Use forced tool calls</Label>
                  </div>
                  {profile.provider === "compatible" && (
                    <div className="checkbox-row">
                      <Checkbox
                        id="disable-thinking"
                        checked={profile.disableThinking}
                        onCheckedChange={checked => change("disableThinking", checked)}
                      />
                      <Label htmlFor="disable-thinking">Disable thinking on MLX servers</Label>
                    </div>
                  )}
                </details>
                <p className="muted">
                  {"This profile sends model requests, its API key, and custom headers to "}
                  <strong>{destination}</strong>
                  . Requests can include page text, questions, and relevant memories.
                </p>
                {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
                <div className="button-row">
                  <Button type="submit">{savedProfile ? "Save changes" : "Save profile"}</Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={closeEditor}
                  >
                    Cancel
                  </Button>
                  {savedProfile && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void remove()}
                    >
                      Remove profile
                    </Button>
                  )}
                </div>
              </fieldset>
            </form>
          </div>
        )}
      </dialog>
      {!editorOpen && error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert role="status"><AlertDescription>{notice}</AlertDescription></Alert>}
    </Card>
  );
}
