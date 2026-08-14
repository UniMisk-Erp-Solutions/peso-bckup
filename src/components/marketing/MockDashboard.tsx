import { Badge } from "@/components/ui/badge";

export function MockDashboard() {
  return (
    <div className="relative bg-white rounded-xl shadow-2xl border border-gray-200 p-6 max-w-lg">
      <div className="space-y-6">
        {/* Recent Expenses */}
        <div>
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Expenses</h3>
          <div className="space-y-2">
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">Office Supplies</p>
                <p className="text-xs text-gray-500">₹2,450</p>
              </div>
              <Badge className="bg-blue-100 text-blue-800 border-blue-200">Submitted</Badge>
            </div>
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">Travel Expense</p>
                <p className="text-xs text-gray-500">₹5,200</p>
              </div>
              <Badge className="bg-green-100 text-green-800 border-green-200">Verified</Badge>
            </div>
            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-100">
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">Team Lunch</p>
                <p className="text-xs text-gray-500">₹1,800</p>
              </div>
              <Badge className="bg-green-100 text-green-800 border-green-200">Approved</Badge>
            </div>
          </div>
        </div>

        {/* Balance Overview */}
        <div className="pt-4 border-t">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Balance Overview</h3>
          <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-lg p-4 border border-blue-100">
            <p className="text-2xl font-bold text-blue-600 mb-1">₹12,450</p>
            <p className="text-xs text-gray-600">Available Balance</p>
          </div>
          
          {/* Mini Chart */}
          <div className="mt-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600 w-16">This Month</span>
              <div className="flex-1 bg-gray-200 rounded-full h-2">
                <div className="bg-blue-600 h-2 rounded-full" style={{ width: '65%' }}></div>
              </div>
              <span className="text-xs font-medium text-gray-900">₹8,100</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600 w-16">Last Month</span>
              <div className="flex-1 bg-gray-200 rounded-full h-2">
                <div className="bg-indigo-600 h-2 rounded-full" style={{ width: '80%' }}></div>
              </div>
              <span className="text-xs font-medium text-gray-900">₹9,800</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
