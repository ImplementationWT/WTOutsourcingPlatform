import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/lib/query-client";

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delay={300}>
        <Toaster>
          <ConfirmProvider>{children}</ConfirmProvider>
        </Toaster>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
