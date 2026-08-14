import { useAuth } from "@/contexts/AuthContext";
import {
  LANGUAGE_LABELS,
  getEnabledLanguagesFromEnv,
  type AppLanguage,
} from "@/i18n/config";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useTranslation } from "react-i18next";
import { useState } from "react";

export function LanguageSelector() {
  const { preferredLanguage, setPreferredLanguage, user } = useAuth();
  const { toast } = useToast();
  const { t } = useTranslation("common");
  const [saving, setSaving] = useState(false);
  const enabled = getEnabledLanguagesFromEnv();

  const onChange = async (value: string) => {
    const lang = value as AppLanguage;
    if (lang === preferredLanguage) return;
    try {
      setSaving(true);
      await setPreferredLanguage(lang);
      toast({ title: t("languageSaved") });
    } catch {
      toast({
        variant: "destructive",
        title: t("languageSaveFailed"),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor="app-language">{t("language")}</Label>
      <Select
        value={preferredLanguage}
        onValueChange={onChange}
        disabled={saving || !user}
      >
        <SelectTrigger id="app-language">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {enabled.map((lang) => (
            <SelectItem key={lang} value={lang}>
              {LANGUAGE_LABELS[lang]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t("languageDescription")}</p>
    </div>
  );
}
