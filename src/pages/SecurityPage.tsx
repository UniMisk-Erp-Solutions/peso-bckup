import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { MarketingLayout } from "@/components/marketing/MarketingLayout";
import { Section, SectionBand } from "@/components/marketing/Section";
import { HeroBackdrop } from "@/components/marketing/HeroBackdrop";
import { FloatingOrbs } from "@/components/marketing/FloatingOrbs";
import { ShieldLockIllustration } from "@/components/marketing/PageIllustrations";
import { SEOHead } from "@/components/SEOHead";
import { absoluteUrl, DEFAULT_OG_IMAGE } from "@/lib/siteConfig";
import { breadcrumbSchema } from "@/lib/schema/jsonLd";
import {
    Shield,
    Lock,
    Database,
    Users,
    FileCheck,
    CheckCircle2,
    ArrowRight,
    Eye,
    Server
} from "lucide-react";

export default function SecurityPage() {
    const navigate = useNavigate();

    const faqSchema = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": "Where is data stored in PesoWise?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "Data is stored in secure cloud infrastructure with encryption at rest. All database connections use SSL/TLS encryption."
                }
            },
            {
                "@type": "Question",
                "name": "How is access controlled in PesoWise?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "Access is controlled through Row Level Security (RLS) policies at the database level, combined with role-based permissions. Even if someone bypasses the frontend, the database enforces access rules."
                }
            },
            {
                "@type": "Question",
                "name": "Can we get security documentation?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "Yes, we provide security documentation and compliance information. Contact us to request a security overview document."
                }
            },
            {
                "@type": "Question",
                "name": "How does organization isolation work?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "PesoWise uses strict organization-level data isolation. Each user belongs to one organization, and all data including expenses, receipts, and balances are scoped to that organization. Cross-organization visibility is prevented at the database level."
                }
            },
            {
                "@type": "Question",
                "name": "Are receipts stored securely?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "Yes, receipts are stored with organization-scoped paths and require authenticated access. Only users who are members of the organization can access receipts. File type restrictions (PDF/JPG/PNG) and size limits are enforced."
                }
            },
            {
                "@type": "Question",
                "name": "Who can see custom form field values on an expense?",
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": "Custom field values inherit the same visibility rules as the parent expense. Reviewers, admins, and other roles authorized to view an expense can see saved category-specific field data on review and detail views."
                }
            }
        ]
    };

    return (
        <>
            <SEOHead
                title="Security & compliance | PesoWise"
                description="How PesoWise uses role-based access, row-level security, encryption, and audit trails—including custom field visibility tied to expense access."
                canonicalUrl={absoluteUrl("/security")}
                ogImage={DEFAULT_OG_IMAGE}
                faqSchema={faqSchema}
                structuredData={breadcrumbSchema([
                    { name: "Home", path: "/" },
                    { name: "Security", path: "/security" },
                ])}
            />
            <MarketingLayout>
                {/* Hero */}
                <Section className="relative py-20 overflow-hidden">
                    <div className="absolute inset-0 w-full">
                        <HeroBackdrop />
                        <FloatingOrbs />
                    </div>
                    <div className="relative grid lg:grid-cols-2 gap-10 lg:gap-14 items-center">
                        <div className="space-y-6">
                            <h1 className="text-4xl sm:text-5xl font-bold text-gray-900">
                                Security you don't have to think about
                            </h1>
                            <p className="text-xl text-gray-600">
                                PesoWise enforces access control at the database level—so privacy and isolation are built-in, not bolted on.
                            </p>
                            <div className="flex flex-col sm:flex-row gap-4 justify-center pt-4">
                                <Button size="lg" onClick={() => navigate("/contact")} className="text-lg px-8">
                                    Contact Security
                                    <ArrowRight className="ml-2 h-5 w-5" />
                                </Button>
                                <Button size="lg" variant="outline" onClick={() => navigate("/auth")} className="text-lg px-8">
                                    Login
                                </Button>
                            </div>
                        </div>
                        <div className="relative w-full max-w-none lg:justify-self-end">
                            <ShieldLockIllustration />
                        </div>
                    </div>
                </Section>

                {/* Security Pillars */}
                <SectionBand>
                    <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">Security Pillars</h2>
                    <p className="text-center text-gray-600 mb-8">
                        See our <a href="/pricing" className="text-blue-600 hover:underline font-medium">pricing plans</a> that include enterprise security features.
                    </p>
                    <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
                        <Card className="hover:shadow-lg transition-all hover:-translate-y-1">
                            <CardHeader>
                                <Database className="h-10 w-10 text-blue-600 mb-4" />
                                <CardTitle>RLS Enforcement</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-sm text-gray-600">Database-level security policies protect all data</p>
                            </CardContent>
                        </Card>
                        <Card className="hover:shadow-lg transition-all hover:-translate-y-1">
                            <CardHeader>
                                <Shield className="h-10 w-10 text-blue-600 mb-4" />
                                <CardTitle>Org Isolation</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-sm text-gray-600">Strict separation between organizations</p>
                            </CardContent>
                        </Card>
                        <Card className="hover:shadow-lg transition-all hover:-translate-y-1">
                            <CardHeader>
                                <Lock className="h-10 w-10 text-blue-600 mb-4" />
                                <CardTitle>Secure Storage</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-sm text-gray-600">Encrypted file storage for receipts</p>
                            </CardContent>
                        </Card>
                        <Card className="hover:shadow-lg transition-all hover:-translate-y-1">
                            <CardHeader>
                                <Eye className="h-10 w-10 text-blue-600 mb-4" />
                                <CardTitle>Audit Trails</CardTitle>
                            </CardHeader>
                            <CardContent>
                                <p className="text-sm text-gray-600">Complete activity logs for compliance</p>
                            </CardContent>
                        </Card>
                    </div>
                </SectionBand>

                {/* Authentication */}
                <Section>
                    <Card className="max-w-4xl mx-auto">
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <Lock className="h-8 w-8 text-blue-600" />
                                <CardTitle className="text-2xl">Authentication</CardTitle>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-2 text-gray-700">
                            <p>• Email + password</p>
                            <p>• Optional email verification</p>
                            <p>• Secure sessions</p>
                        </CardContent>
                    </Card>
                </Section>

                {/* Authorization */}
                <SectionBand>
                    <Card className="max-w-4xl mx-auto">
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <Users className="h-8 w-8 text-blue-600" />
                                <CardTitle className="text-2xl">Authorization (Role-based)</CardTitle>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <p className="text-gray-700 mb-4">Roles: Admin, Engineer, Employee, Cashier, Team Leader, Executive, and hierarchy reviewers</p>
                            <div className="space-y-2 text-gray-600">
                                <p>• Clear permissions summary (employees own data, engineers and hierarchy reviewers scoped, admin org-wide, cashier balance ops)</p>
                                <p>• Custom form field values visible only when the parent expense is visible to the caller</p>
                            </div>
                        </CardContent>
                    </Card>
                </SectionBand>

                {/* Row Level Security */}
                <SectionBand>
                    <Card className="max-w-4xl mx-auto">
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <Database className="h-8 w-8 text-blue-600" />
                                <CardTitle className="text-2xl">Row Level Security (RLS)</CardTitle>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-4 text-gray-700">
                            <p>• Policies protect sensitive tables</p>
                            <p>• Filter by user identity + organization_id + role</p>
                            <p className="font-medium text-gray-900">Even if someone tampers with the frontend, the database rejects unauthorized access.</p>
                        </CardContent>
                    </Card>
                </SectionBand>

                {/* Organization Isolation */}
                <Section>
                    <Card className="max-w-4xl mx-auto">
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <Shield className="h-8 w-8 text-blue-600" />
                                <CardTitle className="text-2xl">Organization Isolation</CardTitle>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-2 text-gray-700">
                            <p>• One org per user, no cross-org visibility</p>
                            <p>• Receipts stored with org-scoped paths</p>
                        </CardContent>
                    </Card>
                </Section>

                {/* Receipt Storage Security */}
                <SectionBand>
                    <Card className="max-w-4xl mx-auto">
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <FileCheck className="h-8 w-8 text-blue-600" />
                                <CardTitle className="text-2xl">Receipt Storage Security</CardTitle>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-2 text-gray-700">
                            <p>• Authenticated access only, org membership rules</p>
                            <p>• File type restrictions: PDF/JPG/PNG</p>
                            <p>• Size limits: 2MB combined for all files</p>
                        </CardContent>
                    </Card>
                </SectionBand>

                {/* Audit Trails */}
                <Section>
                    <Card className="max-w-4xl mx-auto">
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <Eye className="h-8 w-8 text-blue-600" />
                                <CardTitle className="text-2xl">Audit Trails</CardTitle>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-2 text-gray-700">
                            <p>• Who did what + timestamps for submissions, decisions, balance changes</p>
                        </CardContent>
                    </Card>
                </Section>

                {/* Data Protection */}
                <SectionBand>
                    <Card className="max-w-4xl mx-auto">
                        <CardHeader>
                            <div className="flex items-center gap-3">
                                <Server className="h-8 w-8 text-blue-600" />
                                <CardTitle className="text-2xl">Data Protection</CardTitle>
                            </div>
                        </CardHeader>
                        <CardContent className="space-y-2 text-gray-700">
                            <p>• HTTPS</p>
                            <p>• Input validation</p>
                            <p>• Least privilege</p>
                        </CardContent>
                    </Card>
                </SectionBand>

                {/* Security Checklist */}
                <Section>
                    <Card className="border-2 border-blue-200 max-w-4xl mx-auto">
                        <CardHeader>
                            <CardTitle className="text-2xl">Security Checklist</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-start gap-3">
                                <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                                <div>
                                    <p className="font-medium text-gray-900">Row Level Security (RLS)</p>
                                    <p className="text-sm text-gray-600">Database policies enforce access control</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                                <div>
                                    <p className="font-medium text-gray-900">Organization Isolation</p>
                                    <p className="text-sm text-gray-600">Complete data separation per organization</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                                <div>
                                    <p className="font-medium text-gray-900">Secure File Storage</p>
                                    <p className="text-sm text-gray-600">Encrypted receipt storage with access controls</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                                <div>
                                    <p className="font-medium text-gray-900">Audit Logs</p>
                                    <p className="text-sm text-gray-600">Complete trail of all actions and changes</p>
                                </div>
                            </div>
                            <Button onClick={() => navigate("/contact")} className="w-full mt-6">
                                Request Security Overview
                            </Button>
                        </CardContent>
                    </Card>
                </Section>

                {/* FAQ */}
                <SectionBand>
                    <h2 className="text-3xl font-bold text-center text-gray-900 mb-12">Security FAQ</h2>
                    <div className="max-w-3xl mx-auto">
                        <Accordion type="single" collapsible className="w-full">
                            <AccordionItem value="item-1">
                                <AccordionTrigger>Where is data stored?</AccordionTrigger>
                                <AccordionContent>
                                    Data is stored in secure cloud infrastructure with encryption at rest. All database connections use SSL/TLS encryption.
                                </AccordionContent>
                            </AccordionItem>
                            <AccordionItem value="item-2">
                                <AccordionTrigger>How is access controlled?</AccordionTrigger>
                                <AccordionContent>
                                    Access is controlled through Row Level Security (RLS) policies at the database level, combined with role-based permissions. Even if someone bypasses the frontend, the database enforces access rules.
                                </AccordionContent>
                            </AccordionItem>
                            <AccordionItem value="item-3">
                                <AccordionTrigger>Can we get security documentation?</AccordionTrigger>
                                <AccordionContent>
                                    Yes, we provide security documentation and compliance information. Contact us to request a security overview document.
                                </AccordionContent>
                            </AccordionItem>
                            <AccordionItem value="item-4">
                                <AccordionTrigger>How does organization isolation work?</AccordionTrigger>
                                <AccordionContent>
                                    PesoWise uses strict organization-level data isolation. Each user belongs to one organization, and all data including expenses, receipts, and balances are scoped to that organization. Cross-organization visibility is prevented at the database level.
                                </AccordionContent>
                            </AccordionItem>
                            <AccordionItem value="item-5">
                                <AccordionTrigger>Are receipts stored securely?</AccordionTrigger>
                                <AccordionContent>
                                    Yes, receipts are stored with organization-scoped paths and require authenticated access. Only users who are members of the organization can access receipts. File type restrictions (PDF/JPG/PNG) and size limits are enforced.
                                </AccordionContent>
                            </AccordionItem>
                        </Accordion>
                    </div>
                </SectionBand>

                {/* SEO Reinforcement */}
                <Section className="py-12">
                    <div className="max-w-4xl mx-auto text-center">
                        <p className="text-gray-700 text-lg leading-relaxed">
                            PesoWise implements enterprise-grade security practices including row level security, role-based access control, and comprehensive audit trails. Our expense management software ensures organization-level data isolation and secure receipt storage for compliance-ready financial records.
                        </p>
                    </div>
                </Section>

                {/* Bottom CTA */}
                <SectionBand className="bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-20">
                    <div className="text-center">
                        <h2 className="text-3xl font-bold mb-8">
                            Need security documentation for your organization?
                        </h2>
                        <Button size="lg" variant="secondary" onClick={() => navigate("/contact")} className="text-lg px-8">
                            Request Security Overview
                            <ArrowRight className="ml-2 h-5 w-5" />
                        </Button>
                    </div>
                </SectionBand>
            </MarketingLayout>
        </>
    );
}
