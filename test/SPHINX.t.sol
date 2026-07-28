// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SPHINX} from "../contracts/SPHINX.sol";
import {MockERC20, MockVenueAdapter, MockAggregator} from "../contracts/mocks/Mocks.sol";

contract SPHINXTest is Test {
    SPHINX router;
    MockERC20 usdg;
    MockERC20 nvdaOn;
    MockVenueAdapter venueGood; // better rate
    MockVenueAdapter venueBad;  // worse rate
    MockAggregator feed;

    address agent = address(0xA6E17);
    address user = address(0xBEEF);

    function setUp() public {
        router = new SPHINX(agent);
        usdg = new MockERC20("USDG", "USDG");
        nvdaOn = new MockERC20("NVDA on Robinhood", "NVDAon");

        // 1 USDG -> 0.9 NVDAon (rate expressed as 1e18-scaled)
        venueGood = new MockVenueAdapter(0.9e18);
        // 1 USDG -> 0.8 NVDAon, deliberately worse
        venueBad = new MockVenueAdapter(0.8e18);

        // Chainlink reference: ~0.9 NVDAon per USDG, 18-decimals style
        feed = new MockAggregator(0.9e18);

        router.registerVenue(address(venueBad));   // venueId 0
        router.registerVenue(address(venueGood));  // venueId 1
        router.setReferenceFeed(address(usdg), address(nvdaOn), address(feed));

        usdg.mint(user, 1_000e18);
        vm.prank(user);
        usdg.approve(address(router), type(uint256).max);
    }

    function test_bestVenue_picksHigherQuote() public view {
        (uint256 venueId, uint256 amountOut) = router.bestVenue(address(usdg), address(nvdaOn), 100e18);
        assertEq(venueId, 1, "should pick venueGood");
        assertEq(amountOut, 90e18);
    }

    function test_executeSwap_succeedsWithinSlippage() public {
        vm.prank(user);
        uint256 out = router.executeSwap(1, address(usdg), address(nvdaOn), 100e18, 89e18);
        assertEq(out, 90e18);
        assertEq(nvdaOn.balanceOf(user), 90e18);
    }

    function test_executeSwap_revertsWhenMinAmountOutSetTooLoose() public {
        // Quoted output is 90e18, default max slippage is 1.5% -> the
        // router requires minAmountOut to be at least ~88.65e18. A caller
        // (or a compromised frontend) submitting a much looser floor like
        // 50e18 must be rejected by the router itself, before ever
        // reaching the venue -- this is what protects the user from a
        // sandwich attack even if the frontend UI is malicious or buggy.
        vm.prank(user);
        vm.expectRevert(SPHINX.SlippageExceeded.selector);
        router.executeSwap(1, address(usdg), address(nvdaOn), 100e18, 50e18);
    }

    function test_executeSwap_revertsWhenVenueUnderdelivers() public {
        // The inverse case: user asks for a strict minAmountOut (95e18)
        // above what the venue can actually pay out (90e18). The router's
        // own slippage floor doesn't block this -- it's caught downstream
        // by the venue adapter itself, same as any DEX router.
        vm.prank(user);
        vm.expectRevert("mock: below min");
        router.executeSwap(1, address(usdg), address(nvdaOn), 100e18, 95e18);
    }

    function test_executeSwap_revertsWhenOrderExceedsMaxSize() public {
        router.setPairGuardrails(address(usdg), address(nvdaOn), 50e18, 150, 2000);

        vm.prank(user);
        vm.expectRevert(SPHINX.OrderTooLarge.selector);
        router.executeSwap(1, address(usdg), address(nvdaOn), 100e18, 0);
    }

    function test_executeSwap_revertsOnStaleReferencePrice() public {
        vm.warp(block.timestamp + 3 hours); // ensure enough headroom to go stale without underflow
        feed.setStale(2 hours);

        vm.prank(user);
        vm.expectRevert(SPHINX.ReferencePriceStale.selector);
        router.executeSwap(1, address(usdg), address(nvdaOn), 100e18, 0);
    }

    function test_publishRecommendation_onlyAgent() public {
        vm.prank(user);
        vm.expectRevert(SPHINX.NotAgent.selector);
        router.publishRecommendation(address(usdg), address(nvdaOn), 100e18, "test");

        vm.prank(agent);
        router.publishRecommendation(address(usdg), address(nvdaOn), 100e18, "best liquidity right now");
        // no revert = agent can publish; it never touches executeSwap
    }

    // ── New tests for audit fixes ───────────────────────────────────────

    function test_removeVenue_swapsAndPops() public {
        assertEq(router.venueCount(), 2);
        router.removeVenue(0); // remove venueBad
        assertEq(router.venueCount(), 1);
        // venueGood (id=1) was swapped to id=0
        (uint256 vid, uint256 out) = router.bestVenue(address(usdg), address(nvdaOn), 100e18);
        assertEq(vid, 0);
        assertEq(out, 90e18);
    }

    function test_removeVenue_revertsOnOutOfBounds() public {
        vm.expectRevert(SPHINX.VenueIndexOutOfBounds.selector);
        router.removeVenue(99);
    }

    function test_revokeAgent_disablesPublish() public {
        router.revokeAgent();
        vm.prank(agent);
        vm.expectRevert(SPHINX.NotAgent.selector);
        router.publishRecommendation(address(usdg), address(nvdaOn), 100e18, "should fail");
    }

    function test_executeSwap_revertsOnOutOfBoundsVenue() public {
        vm.prank(user);
        vm.expectRevert(SPHINX.VenueIndexOutOfBounds.selector);
        router.executeSwap(99, address(usdg), address(nvdaOn), 100e18, 0);
    }

    function test_executeSwap_sanityCheckUsesConfiguredDeviation() public {
        // Tighten deviation to 1% (100 bps). Venue quote is ~0.9, so within bounds.
        router.setPairGuardrails(address(usdg), address(nvdaOn), 0, 150, 100);

        vm.prank(user);
        // 90e18 output still passes 1% deviation from 0.9e18 reference
        uint256 out = router.executeSwap(1, address(usdg), address(nvdaOn), 100e18, 89e18);
        assertEq(out, 90e18);
    }

    function test_setVenueActive_revertsOnOutOfBounds() public {
        vm.expectRevert(SPHINX.VenueIndexOutOfBounds.selector);
        router.setVenueActive(99, false);
    }
}
