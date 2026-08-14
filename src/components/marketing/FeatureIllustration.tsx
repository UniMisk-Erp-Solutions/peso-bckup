import { Receipt, Shield, Workflow, Database, Lock, FileCheck } from "lucide-react";

type IllustrationType = "receipt" | "shield" | "workflow" | "database" | "lock" | "filecheck";

interface FeatureIllustrationProps {
  type: IllustrationType;
  className?: string;
}

export function FeatureIllustration({ type, className = "" }: FeatureIllustrationProps) {
  const icons = {
    receipt: Receipt,
    shield: Shield,
    workflow: Workflow,
    database: Database,
    lock: Lock,
    filecheck: FileCheck
  };

  const Icon = icons[type];

  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div className="relative">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-100 to-indigo-100 rounded-2xl blur-2xl opacity-50"></div>
        <div className="relative bg-white rounded-xl p-8 border border-gray-200 shadow-lg">
          <Icon className="h-16 w-16 text-blue-600" />
        </div>
      </div>
    </div>
  );
}
