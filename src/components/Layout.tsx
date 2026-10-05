import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { useAuth } from "@/contexts/AuthContext";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { formatINR } from "@/lib/format";
import { Wallet, Pencil, Eye, EyeOff, CheckCircle, AlertCircle, CircleHelp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Separator } from "@/components/ui/separator";
import { useNotificationManager } from "@/hooks/useNotificationManager";
import { NotificationPopup } from "@/components/NotificationPopup";
import { Helmet } from "react-helmet-async";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { OrganizationLogo } from "@/components/OrganizationLogo";
import { RoleBadgeWithLabels } from "@/components/RoleBadgeWithLabels";
import { useOrganizationRoleLabels } from "@/hooks/useOrganizationRoleLabels";
import { formatRoleLabel, normalizeOrgRole } from "@/lib/roleDisplayConfig";
import { isStandaloneDisplayMode } from "@/lib/pwa";
import { APP_MAIN_SCROLL_ID } from "@/components/ScrollToTop";
import { getPageTitle } from "@/lib/pageTitle";
import { useViewportMode } from "@/hooks/useViewportMode";
import { MobileAppShell } from "@/components/mobile/MobileAppShell";
import { UserActivityNoticeGate } from "@/components/UserActivityNoticeGate";
import { TransferOfferPromptGate } from "@/components/TransferOfferPromptGate";

export function Layout({
  children,
  fullWidth = false,
}: {
  children: React.ReactNode;
  /**
   * Opts this page out of the default max-w-7xl centered content column.
   * Used by dense expense tables (Admin Expenses, Review) so they can use
   * the full available desktop width instead of being capped at 1280px
   * and centered with wasted margins on wider monitors. Every other page
   * keeps the default centered column unless it explicitly opts in too.
   */
  fullWidth?: boolean;
}) {
  const { t } = useTranslation(["nav", "common"]);
  const location = useLocation();
  const { isMobile } = useViewportMode();
  const {
    userProfile,
    userRole,
    user,
    refreshUserProfile,
    organization,
    organizationId,
    refreshOrganization,
    isTenantHost,
    isAccountantCashier,
    userBalance,
  } = useAuth();
  const [editOpen, setEditOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [orgNameDraft, setOrgNameDraft] = useState("");
  const [editingOrgName, setEditingOrgName] = useState(false);
  const [savingOrgName, setSavingOrgName] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  
  const { activeNotifications, removeNotification, handleViewNotification } = useNotificationManager();

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(word => word.charAt(0))
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const { labelFor } = useOrganizationRoleLabels();

  const getRoleDisplayName = (role: string) => {
    const key = normalizeOrgRole(role);
    if (key) {
      if (key === "admin") return labelFor("admin");
      if (key === "engineer") return labelFor("engineer");
      if (key === "employee") return labelFor("employee");
      if (key === "cashier") return labelFor("cashier");
      if (key === "team_leader") return labelFor("team_leader");
      if (key === "executive") return labelFor("executive");
    }
    if (role === "master_admin") return t("roleMasterAdmin");
    return formatRoleLabel(role);
  };

  const saveOrgName = async () => {
    if (!organizationId || !orgNameDraft.trim()) return;
    
    try {
      setSavingOrgName(true);
      const { error } = await supabase
        .from("organizations")
        .update({ name: orgNameDraft.trim() })
        .eq("id", organizationId);
      
      if (error) throw error;
      
      // Refresh organization data
      if (user?.id) {
        const { data: membership } = await supabase
          .from("organization_memberships")
          .select("organization_id")
          .eq("user_id", user.id)
          .eq("is_active", true)
          .maybeSingle();
        
        if (membership?.organization_id) {
          const { data: orgData } = await supabase
            .from("organizations")
            .select("id, name, slug, plan")
            .eq("id", membership.organization_id)
            .single();
          
          // Update context would require refreshing, but for now just close edit mode
        }
      }
      
      setEditingOrgName(false);
      await refreshOrganization();
      toast({
        title: t("orgUpdatedTitle"),
        description: t("orgUpdatedDescription"),
      });
    } catch (e: any) {
      console.error("Failed to update organization name", e);
      toast({
        variant: "destructive",
        title: t("common:error"),
        description: e.message || t("failedUpdateOrgName"),
      });
    } finally {
      setSavingOrgName(false);
    }
  };

  useEffect(() => {
    if (organization?.name && !editingOrgName) {
      setOrgNameDraft(organization.name);
    }
  }, [organization?.name, editingOrgName]);

  useEffect(() => {
    if (!isStandaloneDisplayMode()) return;
    document.documentElement.classList.add("app-standalone-shell");
    return () => document.documentElement.classList.remove("app-standalone-shell");
  }, []);

  // All hooks above — safe to branch here
  if (isMobile) {
    return (
      <>
        <Helmet>
          <title>{getPageTitle(location.pathname)} | PesoWise</title>
          <meta name="robots" content="noindex, nofollow" />
        </Helmet>
        <UserActivityNoticeGate />
        <MobileAppShell>{children}</MobileAppShell>
        {/* Transfer offer approval popup — shown before notification toasts */}
        <TransferOfferPromptGate />
        {/* Notification popups float above the bottom nav */}
        <div className="fixed bottom-24 right-4 z-[60] flex flex-col-reverse gap-2">
          {activeNotifications.map((notification) => (
            <NotificationPopup
              key={notification.id}
              id={notification.id}
              type={notification.type}
              title={notification.title}
              message={notification.message}
              expenseId={notification.expense_id}
              createdAt={notification.created_at}
              onClose={() => removeNotification(notification.id)}
              onView={() => handleViewNotification(notification.expense_id, notification.type)}
            />
          ))}
        </div>
      </>
    );
  }

  return (
    <SidebarProvider>
      <UserActivityNoticeGate />
      <Helmet>
        <title>{getPageTitle(location.pathname)} | PesoWise</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <div className="app-shell min-h-app h-[100dvh] flex w-full max-w-[100vw] overflow-hidden bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-100">
        <AppSidebar />
        <main className="flex-1 flex flex-col min-h-0 min-w-0 w-full max-w-full relative">
          {/* Header — compact on phone / iPad (overlay sidebar) */}
          <header className="shrink-0 border-b sticky top-0 z-30 bg-white/80 backdrop-blur-md supports-[backdrop-filter]:bg-white/60 shadow-sm pt-safe">
            <div className="flex h-[3.25rem] sm:h-16 items-center gap-2 sm:gap-4 px-4 sm:px-6 max-w-full">
              <SidebarTrigger
                className="touch-target rounded-lg p-2 transition-colors flex-shrink-0 hover:bg-gray-100"
              />
              {(userRole === "admin" || userRole === "engineer" || userRole === "employee" || userRole === "cashier") && (
                <Button asChild variant="ghost" size="icon" className="touch-target h-9 w-9 sm:h-10 sm:w-10 flex-shrink-0">
                  <Link to="/help" aria-label={t("openTutorial")} title={t("openTutorial")}>
                    <CircleHelp className="h-4 w-4 sm:h-5 sm:w-5" />
                  </Link>
                </Button>
              )}
              <div className="flex-1 min-w-0 flex items-center gap-2 sm:gap-3">
                <OrganizationLogo
                  forceDefault
                  alt="PesoWise"
                  className="h-5 w-auto sm:h-6 md:h-8 flex-shrink-0 max-w-[120px] sm:max-w-[140px] object-contain"
                />
              <div className="flex-1 min-w-0 overflow-hidden">
                {editingOrgName && userRole === 'admin' ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={orgNameDraft}
                      onChange={(e) => setOrgNameDraft(e.target.value)}
                      className="h-7 text-xs sm:text-sm md:text-base font-semibold"
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter') {
                          await saveOrgName();
                        } else if (e.key === 'Escape') {
                          setEditingOrgName(false);
                          setOrgNameDraft(organization?.name || '');
                        }
                      }}
                      autoFocus
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={saveOrgName}
                      disabled={savingOrgName || !orgNameDraft.trim()}
                    >
                      {savingOrgName ? '...' : '✓'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => {
                        setEditingOrgName(false);
                        setOrgNameDraft(organization?.name || '');
                      }}
                    >
                      ✕
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 group">
                    <h1 
                      className="text-sm sm:text-base font-semibold text-gray-900 truncate cursor-pointer hover:text-gray-700"
                      onClick={() => {
                        if (userRole === 'admin') {
                          setOrgNameDraft(organization?.name || '');
                          setEditingOrgName(true);
                        }
                      }}
                      title={userRole === 'admin' ? t("clickEditOrgName") : ''}
                    >
                      {userRole === 'master_admin' ? t("masterAdminHeader") : (organization?.name || t("organization"))}
                    </h1>
                    {userRole === 'admin' && (
                      <Pencil className="h-3 w-3 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                  </div>
                )}
                <p className="text-xs text-gray-500 hidden sm:block truncate">
                  {t("platformSubtitle")}
                </p>
                </div>
              </div>
              
              {/* User Profile Section */}
              <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
                {/* Balance indicator for employees, engineers, and cashiers */}
                {(userRole === 'employee' || userRole === 'engineer' || (userRole === 'cashier' && !isAccountantCashier)) && userBalance !== null && (
                  <div className={`hidden sm:flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 border rounded-lg max-w-[45vw] ${
                    userRole === 'cashier' 
                      ? 'bg-purple-50 border-purple-200' 
                      : userRole === 'engineer'
                      ? 'bg-blue-50 border-blue-200'
                      : 'bg-green-50 border-green-200'
                  }`}>
                    <Wallet className={`h-3.5 w-3.5 sm:h-4 sm:w-4 flex-shrink-0 ${
                      userRole === 'cashier' ? 'text-purple-600' : userRole === 'engineer' ? 'text-blue-600' : 'text-green-600'
                    }`} />
                    <span className={`text-xs sm:text-sm font-medium whitespace-nowrap ${
                      userRole === 'cashier' ? 'text-purple-700' : userRole === 'engineer' ? 'text-blue-700' : 'text-green-700'
                    }`}>
                      <span className={userBalance < 0 ? 'text-red-600' : ''}>
                        {formatINR(userBalance)}
                      </span>
                    </span>
                  </div>
                )}
                
                <div className="text-right hidden min-[400px]:block min-w-0 flex-shrink-0 max-w-[40vw]">
                  <p className="text-xs sm:text-sm font-medium text-gray-900 truncate">
                    {userProfile?.name || t("loadingProfile")}
                  </p>
                  <div className="flex justify-end items-center gap-1.5 mt-0.5 flex-wrap">
                    {userRole ? (
                      <RoleBadgeWithLabels role={userRole} size="sm" />
                    ) : null}
                    {isAccountantCashier ? (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-5 border-slate-300 text-slate-600">
                        {t("accountantMode")}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <button
                  aria-label={t("editProfile")}
                  className="p-2 rounded hover:bg-gray-100 hidden sm:inline-flex"
                  onClick={() => { setNameDraft(userProfile?.name || ""); setEditOpen(true); }}
                >
                  <Pencil className="h-4 w-4 text-gray-600" />
                </button>
                <Avatar className="h-8 w-8 sm:h-9 sm:w-9">
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs sm:text-sm">
                    {userProfile?.name ? getInitials(userProfile.name) : 'U'}
                  </AvatarFallback>
                </Avatar>
              </div>
            </div>
          </header>
          
          {/* Scrollable page content — primary scroll region on phone / PWA */}
          <div
            id={APP_MAIN_SCROLL_ID}
            className="app-main-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 sm:p-5 md:p-6 pb-safe w-full max-w-full"
          >
            <div className={fullWidth ? "w-full" : "max-w-7xl mx-auto w-full"}>
              {children}
            </div>
          </div>

          {/* Edit Profile Drawer */}
          <Sheet open={editOpen} onOpenChange={(open) => {
            setEditOpen(open);
            if (!open) {
              // Reset all fields when closing
              setCurrentPassword("");
              setNewPassword("");
              setConfirmPassword("");
              setShowCurrentPassword(false);
              setShowNewPassword(false);
              setShowConfirmPassword(false);
            }
          }}>
            <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
              <SheetHeader>
                <SheetTitle>{t("editProfileTitle")}</SheetTitle>
                <SheetDescription>{t("editProfileDescription")}</SheetDescription>
              </SheetHeader>
              <div className="py-4 space-y-6">
                {/* Name Section */}
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-sm font-medium text-gray-700">{t("fullName")}</Label>
                  <Input 
                    id="name"
                    value={nameDraft} 
                    onChange={(e) => setNameDraft(e.target.value)} 
                    placeholder={t("yourName")} 
                  />
                </div>

                <Separator />

                {/* Password Change Section */}
                <div className="space-y-4">
                  <div>
                    <Label className="text-sm font-medium text-gray-700">{t("changePassword")}</Label>
                    <p className="text-xs text-gray-500 mt-1">{t("editProfileDescription")}</p>
                  </div>

                  {/* Current Password */}
                  <div className="space-y-2">
                    <Label htmlFor="current-password" className="text-sm font-medium text-gray-700">{t("currentPassword")}</Label>
                    <div className="relative">
                      <Input
                        id="current-password"
                        type={showCurrentPassword ? "text" : "password"}
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        placeholder={t("currentPasswordPlaceholder")}
                        className="pr-10"
                      />
                      {currentPassword && (
                        <button
                          type="button"
                          onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                          className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors focus:outline-none"
                          aria-label={showCurrentPassword ? t("hidePassword") : t("showPassword")}
                        >
                          {showCurrentPassword ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* New Password */}
                  <div className="space-y-2">
                    <Label htmlFor="new-password" className="text-sm font-medium text-gray-700">{t("newPassword")}</Label>
                    <div className="relative">
                      <Input
                        id="new-password"
                        type={showNewPassword ? "text" : "password"}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder={t("newPasswordPlaceholder")}
                        className={`pr-10 ${
                          newPassword && newPassword.length < 8 ? "border-red-300 focus:border-red-500" : ""
                        }`}
                      />
                      <div className="absolute right-3 top-1/2 transform -translate-y-1/2 flex items-center gap-2">
                        {newPassword && newPassword.length >= 8 && (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        )}
                        {newPassword && (
                          <button
                            type="button"
                            onClick={() => setShowNewPassword(!showNewPassword)}
                            className="text-gray-400 hover:text-gray-600 transition-colors focus:outline-none"
                            aria-label={showNewPassword ? t("hidePassword") : t("showPassword")}
                          >
                            {showNewPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                    {newPassword && newPassword.length < 8 && (
                      <p className="text-xs text-red-500 flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" />
                        {t("passwordMin8")}
                      </p>
                    )}
                  </div>

                  {/* Confirm Password */}
                  <div className="space-y-2">
                    <Label htmlFor="confirm-password" className="text-sm font-medium text-gray-700">{t("confirmPassword")}</Label>
                    <div className="relative">
                      <Input
                        id="confirm-password"
                        type={showConfirmPassword ? "text" : "password"}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder={t("confirmPasswordPlaceholder")}
                        className={`pr-10 ${
                          confirmPassword && newPassword && confirmPassword !== newPassword ? "border-red-300 focus:border-red-500" : ""
                        }`}
                      />
                      <div className="absolute right-3 top-1/2 transform -translate-y-1/2 flex items-center gap-2">
                        {confirmPassword && newPassword && confirmPassword === newPassword && newPassword.length >= 8 && (
                          <CheckCircle className="h-4 w-4 text-green-500" />
                        )}
                        {confirmPassword && (
                          <button
                            type="button"
                            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                            className="text-gray-400 hover:text-gray-600 transition-colors focus:outline-none"
                            aria-label={showConfirmPassword ? t("hidePassword") : t("showPassword")}
                          >
                            {showConfirmPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                    {confirmPassword && newPassword && confirmPassword !== newPassword && (
                      <p className="text-xs text-red-500 flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" />
                        {t("passwordMismatch")}
                      </p>
                    )}
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="pt-4 flex gap-2">
                  <Button 
                    variant="outline" 
                    onClick={() => {
                      setEditOpen(false);
                      setCurrentPassword("");
                      setNewPassword("");
                      setConfirmPassword("");
                    }}
                    className="flex-1"
                  >
                    {t("common:cancel")}
                  </Button>
                  <Button 
                    disabled={savingName || changingPassword || !nameDraft.trim()} 
                    onClick={async () => {
                      if (!user?.id) return;
                      try {
                        setSavingName(true);
                        const { error } = await supabase
                          .from("profiles")
                          .update({ name: nameDraft.trim() })
                          .eq("user_id", user.id);
                        if (error) throw error;
                        await refreshUserProfile(user.id);
                        toast({
                          title: t("profileUpdated"),
                          description: t("nameUpdatedDescription"),
                        });
                      } catch (e: any) {
                        console.error("Failed to update name", e);
                        toast({
                          variant: "destructive",
                          title: t("common:error"),
                          description: e.message || t("failedUpdateName"),
                        });
                      } finally {
                        setSavingName(false);
                      }
                    }}
                    className="flex-1"
                  >
                    {savingName ? t("common:saving") : t("saveName")}
                  </Button>
                </div>

                {/* Change Password Button */}
                {(currentPassword || newPassword || confirmPassword) && (
                  <Button 
                    disabled={changingPassword || !currentPassword || !newPassword || !confirmPassword || newPassword.length < 8 || newPassword !== confirmPassword}
                    onClick={async () => {
                      if (!user?.email) return;
                      
                      try {
                        setChangingPassword(true);

                        // Verify current password by attempting to sign in
                        const { error: signInError } = await supabase.auth.signInWithPassword({
                          email: user.email,
                          password: currentPassword,
                        });

                        if (signInError) {
                          throw new Error(t("currentPasswordIncorrect"));
                        }

                        // Update password
                        const { error: updateError } = await supabase.auth.updateUser({
                          password: newPassword,
                        });

                        if (updateError) throw updateError;

                        toast({
                          title: t("passwordChanged"),
                          description: t("passwordChangedDescription"),
                        });

                        // Clear password fields
                        setCurrentPassword("");
                        setNewPassword("");
                        setConfirmPassword("");
                      } catch (e: any) {
                        console.error("Failed to change password", e);
                        toast({
                          variant: "destructive",
                          title: t("common:error"),
                          description: e.message || t("failedChangePassword"),
                        });
                      } finally {
                        setChangingPassword(false);
                      }
                    }}
                    className="w-full"
                  >
                    {changingPassword ? t("changingPassword") : t("changePassword")}
                  </Button>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </main>
        
        {/* Transfer offer approval popup */}
        <TransferOfferPromptGate />
        {/* Notification Popups */}
        <div className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2">
          {activeNotifications.map((notification) => (
            <NotificationPopup
              key={notification.id}
              id={notification.id}
              type={notification.type}
              title={notification.title}
              message={notification.message}
              expenseId={notification.expense_id}
              createdAt={notification.created_at}
              onClose={() => removeNotification(notification.id)}
              onView={() => handleViewNotification(notification.expense_id, notification.type)}
            />
          ))}
        </div>
      </div>
    </SidebarProvider>
  );
}
