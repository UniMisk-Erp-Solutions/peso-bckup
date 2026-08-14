# PesoWise - Expense Management Software (ERP-friendly)

<div align="center">

![PesoWise Logo](/HERO.png)

**Streamline expense management with PesoWise—a comprehensive SaaS platform for employee reimbursements, automated approval workflows, and finance processes that align with your ERP.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)](https://reactjs.org/)
[![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)

**Powered by [Unimisk](https://unimisk.com)**

</div>

---

## 📖 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [User Roles & Permissions](#-user-roles--permissions)
- [Workflow](#-workflow)
- [Tech Stack](#-tech-stack)
- [Getting Started](#-getting-started)
- [Project Structure](#-project-structure)
- [API Documentation](#-api-documentation)
- [Security](#-security)
- [Testing](#-testing)
- [Deployment](#-deployment)
- [Contributing](#-contributing)
- [Support](#-support)
- [License](#-license)

---

## 🎯 Overview

**PesoWise** is a modern, multi-tenant SaaS application for expense management and employee reimbursements. Built with enterprise-grade security and scalability in mind, PesoWise provides a seamless experience for employees, engineers, administrators, and cashiers to track, approve, and manage financial workflows alongside your ERP or accounting stack.

### Why PesoWise?

- ✅ **Multi-Organization Support** - Complete data isolation for multiple tenants
- ✅ **Role-Based Access Control** - Granular permissions for different user types
- ✅ **Automated Workflows** - Streamlined approval processes from submission to payment
- ✅ **Real-Time Balance Tracking** - Instant updates on cash balances and transactions
- ✅ **Comprehensive Audit Trail** - Full compliance with detailed logging
- ✅ **Modern UI/UX** - Intuitive interface built with shadcn/ui and Tailwind CSS
- ✅ **Secure & Scalable** - Built on Supabase with Row Level Security (RLS)

---

## ✨ Key Features

### Core Functionality

#### 💰 Expense Management
- **Draft & Submit Flow** - Employees create expense drafts and submit for review
- **Multi-Step Approval** - Engineer verification → Admin approval workflow
- **Line Item Tracking** - Detailed breakdown of expenses with categories
- **Receipt Management** - Upload and attach receipts (PDF, PNG, JPG)
- **Status Tracking** - Real-time visibility into expense status
- **Transaction Numbers** - Unique transaction IDs per organization

#### 👥 User Management
- **Admin-Only User Creation** - Secure user onboarding
- **Role Assignment** - Assign roles during user creation
- **Profile Management** - Comprehensive user profiles with organization context
- **Balance Management** - Set and track individual user balances

#### 💵 Balance & Cash Management
- **Real-Time Balance Tracking** - Instant balance updates
- **Cash Transfer System** - Cashiers can transfer funds between accounts
- **Automatic Deductions** - Balance reduced when expenses are approved
- **Balance History** - Complete transaction history
- **Money Return Requests** - Employees can request balance returns

#### 📊 Analytics & Reporting
- **Dashboard Analytics** - Visual charts and insights
- **Expense Reports** - Comprehensive financial reports
- **Category Analytics** - Track spending by category
- **User Statistics** - Role-based dashboard views
- **Export Capabilities** - Download reports in various formats

#### 🏢 Multi-Tenancy
- **Organization Isolation** - Complete data separation per organization
- **Custom Organization Settings** - Per-organization configuration
- **Organization Logos** - Branded experience per tenant
- **Location Management** - Multi-location support with location-based cashier assignment

#### 🔔 Notifications
- **Real-Time Notifications** - Instant updates on expense status changes
- **Email Notifications** - Configurable email alerts
- **Notification Preferences** - User-customizable notification settings
- **In-App Notifications** - Popup notifications for important events

---

## 👤 User Roles & Permissions

### 🔴 Admin
**Full system access and management capabilities**

- Create and manage users across the organization
- Approve/reject verified expenses
- Set and manage user balances
- Access all expense reports and analytics
- Manage expense categories and locations
- Configure organization settings
- View comprehensive system reports
- Manage cashier assignments

### 🟡 Engineer
**Review and verification responsibilities**

- Review assigned employee expenses
- Verify expense details and documentation
- Add comments and feedback on expenses
- View assigned employees' expense reports
- Manage employee balances (add funds)
- Approve expenses within approval limit
- Access analytics for assigned employees

### 🟢 Employee
**Expense submission and tracking**

- Create and submit expense reports
- Upload receipts and supporting documents
- View personal expense history
- Track expense status and approvals
- View personal balance information
- Edit draft expenses
- Request money returns

### 🔵 Cashier
**Balance and fund management**

- Add funds to employee/engineer accounts
- Deduct from own balance when adding funds
- View balance management interface
- Access user balance information
- View cash transfer history
- Manage money assignments
- Process money return requests

---

## 🔄 Workflow

### Expense Lifecycle

```
1. DRAFT
   └─ Employee creates expense with line items
   └─ Upload receipts and documents
   └─ Save as draft for later editing

2. SUBMITTED
   └─ Employee submits expense for review
   └─ Status changes to "Under Review"

3. UNDER REVIEW
   └─ Admin can assign to Engineer (optional)
   └─ Engineer reviews expense details

4. VERIFIED
   └─ Engineer verifies expense
   └─ Adds comments/feedback
   └─ Status changes to "Verified"

5. APPROVED/REJECTED
   └─ Admin makes final decision
   └─ If approved: Balance automatically deducted
   └─ If rejected: Employee can edit and resubmit

6. PAID
   └─ Accounting processes payment
   └─ Expense marked as paid
```

### Balance Management Flow

```
Cashier/Admin/Engineer → Add Funds → Employee Balance Updated
Employee → Submit Expense → Admin Approves → Balance Deducted
Employee → Request Return → Cashier Processes → Balance Returned
```

---

## 🛠️ Tech Stack

### Frontend
- **React 18** - Modern UI library with hooks
- **TypeScript** - Type-safe development
- **Vite** - Fast build tool and dev server
- **Tailwind CSS** - Utility-first CSS framework
- **shadcn/ui** - High-quality component library
- **React Router DOM v6** - Client-side routing
- **React Hook Form** - Form state management
- **Zod** - Schema validation
- **TanStack Query** - Server state management
- **Recharts** - Data visualization
- **Lucide React** - Icon library
- **Framer Motion** - Animation library

### Backend
- **Supabase** - Backend-as-a-Service
  - **PostgreSQL** - Relational database
  - **Supabase Auth** - Authentication & authorization
  - **Supabase Storage** - File storage
  - **Row Level Security (RLS)** - Database-level security
  - **Real-time Subscriptions** - Live data updates

### Development Tools
- **Vitest** - Unit testing framework
- **Testing Library** - Component testing
- **ESLint** - Code linting
- **TypeScript** - Static type checking

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18+ and npm (or yarn/pnpm)
- **Supabase Account** - [Sign up for free](https://supabase.com)
- **Git** - Version control

### Installation

#### 1. Clone the Repository

```bash
git clone https://github.com/your-org/pesowise.git
cd pesowise
```

#### 2. Install Dependencies

```bash
npm install
```

#### 3. Environment Setup

Create a `.env.local` file in the root directory:

```env
# Supabase Configuration
VITE_SUPABASE_URL=your_supabase_project_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

**Important Notes:**
- Get your Supabase credentials from: **Dashboard → Settings → API**
- **Never** put the service role key in a `VITE_*` variable (it would ship in the browser bundle). Admin user creation uses the `admin-create-user` Edge Function; set `SUPABASE_SERVICE_ROLE_KEY` only in Supabase Edge Function secrets.
- Deploy Edge Functions after pulling: `supabase functions deploy admin-create-user`
- Never commit `.env.local` to version control

#### 4. Database Setup

##### Option A: Using Supabase CLI (Recommended)

```bash
# Install Supabase CLI
npm install -g supabase

# Initialize Supabase (if not already done)
supabase init

# Link to your project
supabase link --project-ref your-project-ref

# Run migrations
supabase db reset
```

##### Option B: Manual Migration

1. Go to your Supabase Dashboard
2. Navigate to **SQL Editor**
3. Run the migration files in order from `master_migration/`:
   - `01_cleanup.sql`
   - `02_schema.sql`
   - `03_policies.sql`
   - `04_saas_multi_tenancy.sql`
   - `05_update_rls_for_organizations.sql`
   - Continue with remaining migrations...

#### 5. Create Initial Organization and Admin

Since the system requires an admin to create users, you need to set up the first organization and admin:

```sql
-- Run this in Supabase SQL Editor
-- Replace with your actual user ID from auth.users

-- 1. Create organization
INSERT INTO public.organizations (name, slug, plan, subscription_status)
VALUES ('Your Organization', 'your-org-slug', 'pro', 'active')
RETURNING id;

-- 2. Create admin membership (replace user_id and organization_id)
INSERT INTO public.organization_memberships (organization_id, user_id, role)
VALUES ('organization-id-here', 'user-id-here', 'admin');
```

Alternatively, use the provided script:
```bash
# Check master_migration/create_org_and_admin_complete.sql
```

#### 6. Start Development Server

```bash
npm run dev
```

The application will be available at `http://localhost:5173` (or the port shown in terminal)

---

## 🏗️ Project Structure

```
pesowise/
├── public/                 # Static assets
│   ├── HERO.png           # Logo and favicon
│   ├── robots.txt         # SEO robots file
│   └── sitemap.xml        # SEO sitemap
│
├── src/
│   ├── components/        # React components
│   │   ├── ui/           # shadcn/ui components
│   │   ├── AppSidebar.tsx
│   │   ├── FileUpload.tsx
│   │   ├── Layout.tsx
│   │   ├── ProtectedRoute.tsx
│   │   └── ...
│   │
│   ├── contexts/         # React contexts
│   │   └── AuthContext.tsx
│   │
│   ├── hooks/            # Custom React hooks
│   │   ├── use-mobile.tsx
│   │   ├── use-toast.ts
│   │   └── ...
│   │
│   ├── integrations/     # External integrations
│   │   └── supabase/
│   │       ├── client.ts
│   │       └── types.ts
│   │
│   ├── lib/              # Utility functions
│   │   ├── format.ts
│   │   ├── utils.ts
│   │   └── organizationCache.ts
│   │
│   ├── pages/            # Page components
│   │   ├── Auth.tsx
│   │   ├── Dashboard.tsx
│   │   ├── Expenses.tsx
│   │   ├── ExpenseForm.tsx
│   │   ├── ExpenseDetail.tsx
│   │   ├── AdminPanel.tsx
│   │   ├── UserManagement.tsx
│   │   ├── EngineerReview.tsx
│   │   ├── Balances.tsx
│   │   ├── Analytics.tsx
│   │   ├── Reports.tsx
│   │   ├── Settings.tsx
│   │   └── ...
│   │
│   ├── services/         # Business logic
│   │   ├── ExpenseService.ts
│   │   ├── MoneyReturnService.ts
│   │   └── NotificationService.ts
│   │
│   ├── test/             # Test utilities
│   │   └── setup.ts
│   │
│   ├── App.tsx           # Main app component
│   ├── main.tsx          # Entry point
│   └── index.css         # Global styles
│
├── master_migration/     # Database migrations
│   ├── 01_cleanup.sql
│   ├── 02_schema.sql
│   ├── 03_policies.sql
│   ├── 04_saas_multi_tenancy.sql
│   └── ...
│
├── supabase/
│   └── migrations/       # Supabase migrations
│
├── docs/                 # Documentation
│   └── openapi.yaml      # API specification
│
├── index.html            # HTML entry point
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
├── vite.config.ts        # Vite configuration
└── tailwind.config.ts    # Tailwind configuration
```

---

## 📚 API Documentation

PesoWise uses Supabase as its backend, providing RESTful APIs and real-time capabilities. The complete API is documented using OpenAPI 3.0 specification.

### View API Documentation

- **OpenAPI Spec**: [`docs/openapi.yaml`](docs/openapi.yaml)
- **Supabase API**: Auto-generated from your Supabase project

### Key API Endpoints

#### Authentication
- `POST /auth/v1/token` - User authentication
- `POST /auth/v1/logout` - User logout
- `GET /auth/v1/user` - Get current user

#### Expenses
- `GET /rest/v1/expenses` - List expenses (filtered by organization)
- `POST /rest/v1/expenses` - Create expense
- `PATCH /rest/v1/expenses/:id` - Update expense
- `POST /rest/v1/rpc/submit_expense` - Submit expense for review
- `POST /rest/v1/rpc/verify_expense` - Engineer verification
- `POST /rest/v1/rpc/approve_expense` - Admin approval

#### Storage
- `POST /storage/v1/object/receipts` - Upload receipt
- `GET /storage/v1/object/receipts/:path` - Download receipt

### Authentication

All API requests require authentication via JWT tokens:

```typescript
const { data, error } = await supabase
  .from('expenses')
  .select('*')
  .eq('organization_id', orgId);
```

---

## 🔒 Security

### Authentication & Authorization

- **JWT-based Authentication** - Secure token-based auth via Supabase
- **Row Level Security (RLS)** - Database-level access control
- **Role-Based Access Control (RBAC)** - Granular permissions
- **Protected Routes** - Client-side route protection
- **Organization Isolation** - Complete data separation

### Data Validation

- **Frontend Validation** - Zod schemas for form validation
- **Backend Validation** - Supabase functions and RLS policies
- **File Validation** - Type and size checks for uploads
- **Input Sanitization** - Protection against XSS attacks

### Audit Trail

- **Comprehensive Logging** - All actions logged in `audit_logs`
- **User Tracking** - Every action linked to user and organization
- **Timestamp Tracking** - Precise action timestamps
- **Immutable Records** - Audit logs cannot be modified

### File Security

- **Secure Storage** - Files stored in Supabase Storage
- **Access Control** - RLS policies on storage buckets
- **File Type Validation** - Only allowed file types accepted
- **Size Limits** - Maximum 10MB per file

---

## 🧪 Testing

### Run Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm test -- --watch

# Run tests with UI
npm run test:ui

# Run tests with coverage
npm run test:coverage
```

### Test Structure

- **Unit Tests**: `src/services/__tests__/` - Test business logic
- **Integration Tests**: `src/__tests__/integration/` - Test component interactions
- **Test Setup**: `src/test/setup.ts` - Mock configurations

### Writing Tests

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import MyComponent from './MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });
});
```

---

## 🚀 Deployment

### Production Build

```bash
npm run build
```

The build output will be in the `dist/` directory.

### Environment Variables

Set these in your production environment (Vercel, Netlify, etc.):

```env
VITE_SUPABASE_URL=your_production_supabase_url
VITE_SUPABASE_ANON_KEY=your_production_supabase_anon_key
```

### Deployment Platforms

#### Vercel (Recommended)

1. Connect your GitHub repository
2. Set environment variables
3. Deploy automatically on push

The `vercel.json` file is already configured for SPA routing.

#### Netlify

1. Connect your repository
2. Set build command: `npm run build`
3. Set publish directory: `dist`
4. Add `_redirects` file in `public/` (already included)

### Supabase Production Setup

1. **Enable RLS** on all tables
2. **Configure Storage Policies** for file uploads
3. **Set CORS Policies** for your domain
4. **Configure Email Templates** for user invitations
5. **Set up Database Backups**

---

## 🤝 Contributing

We welcome contributions! Please follow these steps:

### Development Workflow

1. **Fork the repository**
2. **Create a feature branch**
   ```bash
   git checkout -b feature/amazing-feature
   ```
3. **Make your changes**
4. **Write/update tests** for your changes
5. **Ensure all tests pass**
   ```bash
   npm test
   ```
6. **Commit your changes**
   ```bash
   git commit -m 'feat: Add amazing feature'
   ```
7. **Push to your branch**
   ```bash
   git push origin feature/amazing-feature
   ```
8. **Open a Pull Request**

### Development Guidelines

- ✅ Follow TypeScript best practices
- ✅ Write tests for new features
- ✅ Use conventional commit messages
- ✅ Ensure all tests pass before submitting PR
- ✅ Update documentation for new features
- ✅ Follow the existing code style

### Commit Message Format

```
type(scope): subject

body (optional)

footer (optional)
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`

---

## 🆘 Support

### Getting Help

- **GitHub Issues** - [Create an issue](https://github.com/your-org/pesowise/issues)
- **Documentation** - Check the [API docs](docs/openapi.yaml)
- **Examples** - Review test files for usage examples

### Common Issues

#### "Cannot create user" error
- Deploy the `admin-create-user` Edge Function and ensure `SUPABASE_SERVICE_ROLE_KEY` is set in Supabase (Edge Function secrets)
- Confirm the signed-in user is an organization `admin`
- Check that RLS policies allow profile updates after creation

#### "Organization not found" error
- Verify organization exists in database
- Check organization_memberships table

#### Build errors
- Clear `node_modules` and reinstall: `rm -rf node_modules && npm install`
- Check Node.js version (requires 18+)

---

## 📝 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- **Unimisk** - Powered by Unimisk
- **Supabase** - Backend infrastructure
- **shadcn/ui** - UI component library
- **Vite** - Build tool
- **React** - UI framework

---

<div align="center">

**Made with ❤️ by the PesoWise Team**

[Website](https://pesowise.unimisk.com) • [Documentation](docs/) • [Issues](https://github.com/your-org/pesowise/issues) • [License](LICENSE)

</div>
