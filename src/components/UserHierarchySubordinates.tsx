import { Badge } from "@/components/ui/badge";
import { formatINR } from "@/lib/format";
import type {
  HierarchyEngineerNode,
  HierarchyExecutiveNode,
  HierarchyTeamLeaderNode,
  HierarchyUserRow,
} from "@/lib/userHierarchyView";

type UserHierarchySubordinatesProps = {
  item: HierarchyEngineerNode;
  teamLeaderTierEnabled: boolean;
  executiveTierEnabled: boolean;
  teamLeaderLabel: string;
  executiveLabel: string;
  onUserClick: (user: HierarchyUserRow) => void;
};

const roleStyles: Record<string, { avatar: string; badge: string }> = {
  executive: {
    avatar: "bg-teal-600",
    badge: "bg-teal-600",
  },
  team_leader: {
    avatar: "bg-amber-600",
    badge: "bg-amber-600",
  },
};

function EmployeeGrid({
  employees,
  onUserClick,
}: {
  employees: HierarchyUserRow[];
  onUserClick: (user: HierarchyUserRow) => void;
}) {
  if (employees.length === 0) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
      {employees.map((employee, eIdx) => (
        <div
          key={employee.user_id || eIdx}
          className="bg-white rounded-lg p-3 border border-green-200 shadow-sm cursor-pointer hover:border-green-300 transition-colors"
          onClick={() => onUserClick(employee)}
        >
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-green-600 rounded-full flex items-center justify-center text-white font-bold text-xs">
              {employee.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-xs text-gray-900 truncate">{employee.name}</div>
              <div className="text-xs text-gray-500 truncate">{employee.email}</div>
            </div>
          </div>
          <div className="text-xs text-gray-600 mt-1">
            Balance: {formatINR(Number(employee.balance ?? 0))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PersonHeader({
  user,
  roleKey,
  roleLabel,
  onUserClick,
}: {
  user: HierarchyUserRow;
  roleKey: "executive" | "team_leader";
  roleLabel: string;
  onUserClick: (user: HierarchyUserRow) => void;
}) {
  const style = roleStyles[roleKey];
  return (
    <div
      className="flex items-center gap-2 sm:gap-3 cursor-pointer hover:opacity-90 transition-opacity"
      onClick={() => onUserClick(user)}
    >
      <div
        className={`w-10 h-10 sm:w-11 sm:h-11 ${style.avatar} rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0`}
      >
        {user.name.charAt(0).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-bold text-sm sm:text-base text-gray-900 truncate">{user.name}</div>
        <div className="text-xs text-gray-600 truncate">{user.email}</div>
        <div className="text-xs font-semibold text-gray-700 mt-0.5">
          Balance: {formatINR(Number(user.balance ?? 0))}
        </div>
      </div>
      <Badge variant="default" className={`${style.badge} text-xs flex-shrink-0`}>
        {roleLabel}
      </Badge>
    </div>
  );
}

function TeamLeaderBlock({
  node,
  teamLeaderLabel,
  onUserClick,
}: {
  node: HierarchyTeamLeaderNode;
  teamLeaderLabel: string;
  onUserClick: (user: HierarchyUserRow) => void;
}) {
  return (
    <div className="border border-amber-200 rounded-lg p-3 sm:p-4 bg-amber-50/80">
      <PersonHeader
        user={node.user}
        roleKey="team_leader"
        roleLabel={teamLeaderLabel}
        onUserClick={onUserClick}
      />
      {node.employees.length > 0 && (
        <div className="mt-3 ml-2 sm:ml-4">
          <div className="text-xs font-semibold text-gray-700 mb-2">
            Employees ({node.employees.length})
          </div>
          <EmployeeGrid employees={node.employees} onUserClick={onUserClick} />
        </div>
      )}
    </div>
  );
}

function ExecutiveBlock({
  node,
  teamLeaderTierEnabled,
  teamLeaderLabel,
  executiveLabel,
  onUserClick,
}: {
  node: HierarchyExecutiveNode;
  teamLeaderTierEnabled: boolean;
  teamLeaderLabel: string;
  executiveLabel: string;
  onUserClick: (user: HierarchyUserRow) => void;
}) {
  return (
    <div className="border border-teal-200 rounded-lg p-3 sm:p-4 bg-teal-50/80">
      <PersonHeader
        user={node.user}
        roleKey="executive"
        roleLabel={executiveLabel}
        onUserClick={onUserClick}
      />
      {teamLeaderTierEnabled && node.teamLeaders.length > 0 && (
        <div className="mt-3 ml-2 sm:ml-4 space-y-2">
          <div className="text-xs font-semibold text-gray-700">
            {teamLeaderLabel}s ({node.teamLeaders.length})
          </div>
          {node.teamLeaders.map((tl) => (
            <TeamLeaderBlock
              key={tl.user.user_id}
              node={tl}
              teamLeaderLabel={teamLeaderLabel}
              onUserClick={onUserClick}
            />
          ))}
        </div>
      )}
      {node.employees.length > 0 && (
        <div className="mt-3 ml-2 sm:ml-4">
          <div className="text-xs font-semibold text-gray-700 mb-2">
            Employees ({node.employees.length})
          </div>
          <EmployeeGrid employees={node.employees} onUserClick={onUserClick} />
        </div>
      )}
    </div>
  );
}

export function UserHierarchySubordinates({
  item,
  teamLeaderTierEnabled,
  executiveTierEnabled,
  teamLeaderLabel,
  executiveLabel,
  onUserClick,
}: UserHierarchySubordinatesProps) {
  const hasContent =
    (executiveTierEnabled && item.executives.length > 0) ||
    (teamLeaderTierEnabled && item.teamLeaders.length > 0) ||
    item.employees.length > 0;

  if (!hasContent) return null;

  return (
    <div className="ml-0 sm:ml-4 md:ml-6 space-y-4">
      {executiveTierEnabled && item.executives.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs sm:text-sm font-semibold text-gray-700 flex items-center gap-2">
            <div className="w-12 sm:w-16 h-0.5 bg-teal-300" />
            <span>
              {executiveLabel}s ({item.executives.length})
            </span>
          </div>
          {item.executives.map((ex) => (
            <ExecutiveBlock
              key={ex.user.user_id}
              node={ex}
              teamLeaderTierEnabled={teamLeaderTierEnabled}
              teamLeaderLabel={teamLeaderLabel}
              executiveLabel={executiveLabel}
              onUserClick={onUserClick}
            />
          ))}
        </div>
      )}

      {teamLeaderTierEnabled && item.teamLeaders.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs sm:text-sm font-semibold text-gray-700 flex items-center gap-2">
            <div className="w-12 sm:w-16 h-0.5 bg-amber-300" />
            <span>
              {teamLeaderLabel}s ({item.teamLeaders.length})
            </span>
          </div>
          {item.teamLeaders.map((tl) => (
            <TeamLeaderBlock
              key={tl.user.user_id}
              node={tl}
              teamLeaderLabel={teamLeaderLabel}
              onUserClick={onUserClick}
            />
          ))}
        </div>
      )}

      {item.employees.length > 0 && (
        <div>
          <div className="text-xs sm:text-sm font-semibold text-gray-700 mb-2 flex items-center gap-2">
            <div className="w-12 sm:w-24 h-0.5 bg-green-300" />
            <span>Employees ({item.employees.length})</span>
          </div>
          <EmployeeGrid employees={item.employees} onUserClick={onUserClick} />
        </div>
      )}
    </div>
  );
}
