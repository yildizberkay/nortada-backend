import { globalConfig } from "@/app/global-config";

import { createMockConfig } from "./helpers/mock-config";

// Inject mock config into the global singleton so BaseUseCase.config works in
// unit tests without booting the real env.
(globalConfig as unknown as { _config: unknown })._config = createMockConfig();
