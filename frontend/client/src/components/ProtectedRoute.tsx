// src/components/ProtectedRoute.tsx
import { Redirect } from "wouter";
import { useAppStore } from "@/lib/dataStore";

interface ProtectedRouteProps {
  children: React.ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const currentUser = useAppStore((state) => state.currentUser);

  if (!currentUser?.email) {
    return <Redirect to="/login" />;
  }

  // The data loading is handled by App.tsx; here we just check authentication.
  return <>{children}</>;
}