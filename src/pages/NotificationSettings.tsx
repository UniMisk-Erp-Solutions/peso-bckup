import { useTranslation } from "@/i18n";
import { useNotificationSettings } from "@/hooks/useNotificationSettings";
import type { NotificationSettings } from "@/lib/notificationSettings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Bell, Volume2, VolumeX } from "lucide-react";

export default function NotificationSettings() {
  const { t } = useTranslation(["settings", "common"]);
  const { toast } = useToast();
  // ONE shared load per user (src/lib/notificationSettings.ts): no per-page request, no retry loop.
  const { settings, loading, update } = useNotificationSettings();

  const saveSettings = async (newSettings: NotificationSettings) => {
    try {
      await update(newSettings);
      toast({
        title: t("notificationsPage.saved"),
        description: t("notificationsPage.savedHint"),
      });
    } catch (error) {
      console.error("Error saving notification settings:", error);
      toast({
        variant: "destructive",
        title: t("common:error"),
        description: t("notificationsPage.saveFailed"),
      });
    }
  };

  const updateSetting = (key: keyof NotificationSettings, value: boolean) => {
    const newSettings = { ...settings, [key]: value };
    saveSettings(newSettings);
  };

  if (loading) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("notificationsPage.title")}</h1>
          <p className="text-muted-foreground">{t("notificationsPage.loadingDescription")}</p>
        </div>
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t("notificationsPage.title")}</h1>
        <p className="text-muted-foreground">{t("notificationsPage.description")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            {t("notificationsPage.preferencesTitle")}
          </CardTitle>
          <CardDescription>{t("notificationsPage.preferencesDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="popup" className="text-base">
                {t("notificationsPage.popupLabel")}
              </Label>
              <p className="text-sm text-muted-foreground">{t("notificationsPage.popupHint")}</p>
            </div>
            <Switch
              id="popup"
              checked={settings.popup_enabled}
              onCheckedChange={(checked) => updateSetting("popup_enabled", checked)}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="sound" className="text-base flex items-center gap-2">
                {settings.sound_enabled ? (
                  <Volume2 className="h-4 w-4" />
                ) : (
                  <VolumeX className="h-4 w-4" />
                )}
                {t("notificationsPage.soundLabel")}
              </Label>
              <p className="text-sm text-muted-foreground">{t("notificationsPage.soundHint")}</p>
            </div>
            <Switch
              id="sound"
              checked={settings.sound_enabled}
              onCheckedChange={(checked) => updateSetting("sound_enabled", checked)}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="desktop" className="text-base">
                {t("notificationsPage.desktopLabel")}
              </Label>
              <p className="text-sm text-muted-foreground">{t("notificationsPage.desktopHint")}</p>
            </div>
            <Switch
              id="desktop"
              checked={settings.desktop_enabled}
              onCheckedChange={async (checked) => {
                if (checked && "Notification" in window) {
                  const permission = await Notification.requestPermission();
                  if (permission === "granted") {
                    updateSetting("desktop_enabled", true);
                  } else {
                    toast({
                      variant: "destructive",
                      title: t("notificationsPage.permissionDenied"),
                      description: t("notificationsPage.permissionDeniedHint"),
                    });
                  }
                } else {
                  updateSetting("desktop_enabled", checked);
                }
              }}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
