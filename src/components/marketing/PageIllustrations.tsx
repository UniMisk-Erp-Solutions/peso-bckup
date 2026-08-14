import { Receipt, CheckCircle2, ArrowRight, Shield, Lock, CreditCard, Send } from "lucide-react";

export function ReceiptChecklistIllustration() {
  return (
    <div className="relative">
      <div className="absolute inset-0 bg-gradient-to-br from-blue-100 to-indigo-100 rounded-2xl blur-2xl opacity-50"></div>
      <div className="relative bg-white rounded-xl p-8 border border-gray-200 shadow-lg">
        <div className="space-y-4">
          <Receipt className="h-12 w-12 text-blue-600" />
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <div className="h-2 bg-gray-200 rounded w-32"></div>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <div className="h-2 bg-gray-200 rounded w-24"></div>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <div className="h-2 bg-gray-200 rounded w-28"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FlowDiagramIllustration() {
  return (
    <div className="relative">
      <div className="absolute inset-0 bg-gradient-to-br from-green-100 to-emerald-100 rounded-2xl blur-2xl opacity-50"></div>
      <div className="relative bg-white rounded-xl p-8 border border-gray-200 shadow-lg">
        <div className="flex items-center gap-2">
          <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
            <span className="text-blue-600 font-bold">1</span>
          </div>
          <ArrowRight className="h-6 w-6 text-gray-400" />
          <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
            <span className="text-green-600 font-bold">2</span>
          </div>
          <ArrowRight className="h-6 w-6 text-gray-400" />
          <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center">
            <span className="text-purple-600 font-bold">3</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ShieldLockIllustration() {
  return (
    <div className="relative">
      <div className="absolute inset-0 bg-gradient-to-br from-blue-100 to-indigo-100 rounded-2xl blur-2xl opacity-50"></div>
      <div className="relative bg-white rounded-xl p-8 border border-gray-200 shadow-lg">
        <div className="flex items-center gap-4">
          <Shield className="h-16 w-16 text-blue-600" />
          <Lock className="h-12 w-12 text-indigo-600" />
        </div>
      </div>
    </div>
  );
}

export function PricingCardsIllustration() {
  return (
    <div className="relative">
      <div className="absolute inset-0 bg-gradient-to-br from-purple-100 to-pink-100 rounded-2xl blur-2xl opacity-50"></div>
      <div className="relative bg-white rounded-xl p-8 border border-gray-200 shadow-lg">
        <div className="flex gap-2">
          <div className="w-16 h-20 bg-blue-100 rounded-lg"></div>
          <div className="w-16 h-24 bg-green-100 rounded-lg"></div>
          <div className="w-16 h-20 bg-purple-100 rounded-lg"></div>
        </div>
      </div>
    </div>
  );
}

export function ContactIllustration() {
  return (
    <div className="relative">
      <div className="absolute inset-0 bg-gradient-to-br from-cyan-100 to-blue-100 rounded-2xl blur-2xl opacity-50"></div>
      <div className="relative bg-white rounded-xl p-8 border border-gray-200 shadow-lg">
        <Send className="h-16 w-16 text-blue-600" />
      </div>
    </div>
  );
}
