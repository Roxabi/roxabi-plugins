# Frontend Patterns

Project-specific frontend conventions. Agents read this via `{standards.frontend}`.

> Universal patterns (component design, state management signals, WCAG 2.1 AA, performance) are embedded in the `frontend-dev` agent.
> This file documents **your project's specific** choices.

## Framework & UI Library

<!-- Document your specific stack. Examples:
  - Framework: Next.js 15 (App Router)
  - UI Library: shadcn/ui + Radix primitives
  - Styling: Tailwind CSS v4
  - State: TanStack Query for server state, Zustand for client state
-->

TODO: Document your framework and UI library choices.

## Component Conventions

<!-- Document project-specific component rules. Examples:
  - All shared components in packages/ui/src/
  - Page components in apps/web/src/app/
  - Always use shadcn/ui primitives before hand-rolling
  - Customize via className prop (never override internal styles)
-->

TODO: Document your component conventions.

## Routing & Data Fetching

<!-- Document how your app handles routing and data. Examples:
  - File-based routing (Next.js App Router)
  - Server Components by default, Client Components only when interactive
  - Data fetching: RSC for initial load, TanStack Query for mutations/polling
-->

TODO: Document routing and data fetching patterns.

## Forms & Validation

<!-- Document your form patterns. Examples:
  - React Hook Form + Zod for all forms
  - Server-side validation mirrors client-side schemas
  - Error display: inline per field + toast for server errors
-->

TODO: Document form handling patterns.

## AI Quick Reference

<!-- Compressed imperative rules for dev-core agents. Keep under 10 lines. Examples:
  - ALWAYS check packages/ui/src/index.ts for existing primitives before creating
  - NEVER use `useEffect` for derived state — use `useMemo` or compute in render
  - ALWAYS use Server Components by default (add "use client" only when needed)
-->

TODO: Add concise, imperative rules for agents.
