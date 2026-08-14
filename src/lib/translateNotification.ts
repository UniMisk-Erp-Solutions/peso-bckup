export type StoredNotificationType =
  | "expense_verified"
  | "expense_approved"
  | "expense_submitted"
  | "expense_rejected"
  | "expense_assigned"
  | "balance_added"
  | "transfer_offer_received"
  | "transfer_offer_accepted"
  | "transfer_offer_rejected"
  | "transfer_offer_cancelled";

export interface NotificationLike {
  type: string;
  title: string;
  message: string;
}

/** Localizes notification title/message stored in English in the database. */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

export function translateNotificationDisplay(
  notification: NotificationLike,
  t: TranslateFn,
): { title: string; message: string } {
  const { type, message, title } = notification;

  const approved = message.match(
    /^Your expense "([^"]+)" \(([^)]+)\) has been approved by (.+)$/,
  );
  if (approved) {
    return {
      title: t("templates.expenseApproved.title"),
      message: t("templates.expenseApproved.message", {
        expenseTitle: approved[1],
        amount: approved[2],
        actor: approved[3],
      }),
    };
  }

  const verified = message.match(/^Your expense "([^"]+)" has been verified by (.+)$/);
  if (verified) {
    return {
      title: t("templates.expenseVerified.title"),
      message: t("templates.expenseVerified.message", {
        expenseTitle: verified[1],
        actor: verified[2],
      }),
    };
  }

  const offerReceived = message.match(/^(.+) offered you (.+)\. Accept or reject with a reason\.$/);
  if (offerReceived) {
    return {
      title: t("templates.transferOfferReceived.title"),
      message: t("templates.transferOfferReceived.message", {
        sender: offerReceived[1],
        amount: offerReceived[2],
      }),
    };
  }

  const offerAccepted = message.match(/^(.+) accepted your transfer offer of (.+)\.$/);
  if (offerAccepted) {
    return {
      title: t("templates.transferOfferAccepted.title"),
      message: t("templates.transferOfferAccepted.message", {
        recipient: offerAccepted[1],
        amount: offerAccepted[2],
      }),
    };
  }

  const offerRejected = message.match(
    /^(.+) rejected your transfer offer of (.+)\. Reason: (.+)$/,
  );
  if (offerRejected) {
    return {
      title: t("templates.transferOfferRejected.title"),
      message: t("templates.transferOfferRejected.message", {
        recipient: offerRejected[1],
        amount: offerRejected[2],
        reason: offerRejected[3],
      }),
    };
  }

  const offerCancelled = message.match(/^(.+) cancelled the transfer offer of (.+)\.$/);
  if (offerCancelled) {
    return {
      title: t("templates.transferOfferCancelled.title"),
      message: t("templates.transferOfferCancelled.message", {
        sender: offerCancelled[1],
        amount: offerCancelled[2],
      }),
    };
  }

  const balance = message.match(
    /^Your balance has been updated\. (.+) has been added to your account by (.+)$/,
  );
  if (balance) {
    return {
      title: t("templates.balanceUpdated.title"),
      message: t("templates.balanceUpdated.message", {
        amount: balance[1],
        actor: balance[2],
      }),
    };
  }

  const rejected = message.match(
    /^Your expense "([^"]+)" has been rejected by (.+?)(?:\. Reason: (.+))?$/,
  );
  if (rejected) {
    return {
      title: t("templates.expenseRejected.title"),
      message: rejected[3]
        ? t("templates.expenseRejected.messageWithReason", {
            expenseTitle: rejected[1],
            actor: rejected[2],
            reason: rejected[3],
          })
        : t("templates.expenseRejected.message", {
            expenseTitle: rejected[1],
            actor: rejected[2],
          }),
    };
  }

  const submitted = message.match(/^(.+?) has submitted a new expense: "([^"]+)"$/);
  if (submitted) {
    return {
      title: t("templates.newExpenseClaim.title"),
      message: t("templates.newExpenseClaim.message", {
        employee: submitted[1],
        expenseTitle: submitted[2],
      }),
    };
  }

  const submittedProgress = message.match(
    /^Your expense "([^"]+)" has been submitted and is awaiting (.+) review\.$/,
  );
  if (submittedProgress) {
    return { title, message };
  }

  const forwarded = message.match(
    /^Expense "([^"]+)" from (.+?) is now awaiting (.+?) review\.$/,
  );
  if (forwarded) {
    return {
      title: t("templates.expenseForwarded.title"),
      message: t("templates.expenseForwarded.message", {
        expenseTitle: forwarded[1],
        employee: forwarded[2],
        reviewer: forwarded[3],
      }),
    };
  }

  const awaiting = message.match(
    /^(.+?) has verified "([^"]+)" \(([^)]+)\) from (.+?)\. Please review and approve\.$/,
  );
  if (awaiting) {
    return {
      title: t("templates.expenseVerifiedAwaiting.title"),
      message: t("templates.expenseVerifiedAwaiting.message", {
        engineer: awaiting[1],
        expenseTitle: awaiting[2],
        amount: awaiting[3],
        employee: awaiting[4],
      }),
    };
  }

  const corrected = message.match(
    /^Your expense "([^"]+)" was corrected by (.+?) and marked as adjusted(?:\. Reason: (.+))?\.$/,
  );
  if (corrected) {
    return { title, message };
  }

  const titleByType: Partial<Record<StoredNotificationType, string>> = {
    expense_approved: t("templates.expenseApproved.title"),
    expense_verified: t("templates.expenseVerified.title"),
    expense_rejected: t("templates.expenseRejected.title"),
    expense_submitted: t("templates.newExpenseClaim.title"),
    balance_added: t("templates.balanceUpdated.title"),
    transfer_offer_received: t("templates.transferOfferReceived.title"),
    transfer_offer_accepted: t("templates.transferOfferAccepted.title"),
    transfer_offer_rejected: t("templates.transferOfferRejected.title"),
    transfer_offer_cancelled: t("templates.transferOfferCancelled.title"),
  };

  if (title.includes("Awaiting Approval")) {
    return {
      title: t("templates.expenseVerifiedAwaiting.title"),
      message,
    };
  }

  const localizedTitle = titleByType[type as StoredNotificationType];
  if (localizedTitle) {
    return { title: localizedTitle, message };
  }

  return { title, message };
}
