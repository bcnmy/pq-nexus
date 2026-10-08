// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

// Pulls the pinned Nexus 1.3.3 sources into the build so `forge verify-contract` can submit them to block
// explorers. Deployment itself uses the canonical artifacts (see PqNexusDeployer).
import { Nexus } from "nexus/nexus/Nexus.sol";
import { NexusBootstrap } from "nexus/nexus/utils/NexusBootstrap.sol";
import { NexusAccountFactory } from "nexus/nexus/factory/NexusAccountFactory.sol";
