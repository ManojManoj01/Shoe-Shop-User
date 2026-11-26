import { Injectable, signal, computed, inject, PLATFORM_ID, effect, untracked } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, throwError } from 'rxjs';
import { map, tap, catchError } from 'rxjs/operators';
import { Product } from '../models/product.model';
import { CartItem, CartSummary, Coupon, Order, ShippingAddress } from '../models/cart.model';
import { ToastService } from './toast.service';
import { AuthService } from './auth.service';
import { environment } from '../../../environments/environment';

const COUPON_STORAGE_PREFIX = 'stepstyle_cart_coupon_user_';

export const VALID_COUPONS: Coupon[] = [
  {
    code: 'STEP10',
    discountPercentage: 10,
    description: '10% instant discount on entire order'
  },
  {
    code: 'PALANI500',
    discountAmount: 500,
    minSpend: 1999,
    description: 'Flat ₹500 off on orders above ₹1,999'
  },
  {
    code: 'FIRSTSTEP',
    discountPercentage: 15,
    description: '15% welcome discount for new shoppers'
  }
];

@Injectable({
  providedIn: 'root'
})
export class CartService {
  private platformId = inject(PLATFORM_ID);
  private isBrowser = isPlatformBrowser(this.platformId);
  private toastService = inject(ToastService);
  private authService = inject(AuthService);
  private http = inject(HttpClient);
  private router = inject(Router);

  private baseBackendUrl = (environment.apiUrl || 'https://shoe-shop-backend-1-fpu4.onrender.com').replace(/\/api\/?$/, '');
  private cartApiUrl = `${this.baseBackendUrl}/api/cart`;
  private ordersApiUrl = `${this.baseBackendUrl}/api/orders`;

  private itemsSignal = signal<CartItem[]>([]);
  private couponSignal = signal<Coupon | null>(null);
  private activeUserId: string | null = null;

  // Public readonly signals
  public items = this.itemsSignal.asReadonly();
  public coupon = this.couponSignal.asReadonly();

  // Computations
  public totalQuantity = computed(() => {
    return this.itemsSignal().reduce((acc, item) => acc + item.quantity, 0);
  });

  public subtotal = computed(() => {
    return this.itemsSignal().reduce((acc, item) => acc + item.subtotal, 0);
  });

  public discountAmount = computed(() => {
    const c = this.couponSignal();
    const currentSubtotal = this.subtotal();
    if (!c || currentSubtotal === 0) return 0;

    if (c.minSpend && currentSubtotal < c.minSpend) {
      return 0;
    }

    if (c.discountPercentage) {
      return Math.round((currentSubtotal * c.discountPercentage) / 100);
    }
    if (c.discountAmount) {
      return Math.min(c.discountAmount, currentSubtotal);
    }
    return 0;
  });

  public shippingFee = computed(() => {
    const currentSubtotal = this.subtotal();
    if (currentSubtotal === 0) return 0;
    return currentSubtotal >= 1000 ? 0 : 99;
  });

  public grandTotal = computed(() => {
    const total = this.subtotal() - this.discountAmount() + this.shippingFee();
    return Math.max(0, total);
  });

  public freeShippingThreshold = 1000;
  public freeShippingRemaining = computed(() => {
    const remaining = this.freeShippingThreshold - this.subtotal();
    return remaining > 0 ? remaining : 0;
  });

  public summary = computed<CartSummary>(() => {
    return {
      items: this.itemsSignal(),
      totalQuantity: this.totalQuantity(),
      subtotal: this.subtotal(),
      discount: this.discountAmount(),
      coupon: this.couponSignal() || undefined,
      shippingFee: this.shippingFee(),
      tax: 0,
      grandTotal: this.grandTotal()
    };
  });

  constructor() {
    // Synchronize cart strictly per logged-in user via Spring Boot + Supabase
    effect(() => {
      const user = this.authService.currentUser();
      const token = this.authService.token();

      untracked(() => {
        if (!this.isBrowser) return;

        if (!user || !token) {
          this.activeUserId = null;
          this.itemsSignal.set([]);
          this.couponSignal.set(null);
          return;
        }

        if (this.activeUserId !== user.id) {
          this.activeUserId = user.id;
          this.itemsSignal.set([]);
          this.couponSignal.set(this.loadCouponForUser(user.id));
          this.loadCartFromBackend();
        }
      });
    });
  }

  private getCouponStorageKey(userId: string): string {
    return `${COUPON_STORAGE_PREFIX}${userId}`;
  }

  private loadCouponForUser(userId: string): Coupon | null {
    if (!this.isBrowser) return null;
    try {
      const saved = localStorage.getItem(this.getCouponStorageKey(userId));
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  }

  private saveCouponForUser(): void {
    if (!this.isBrowser || !this.activeUserId) return;
    try {
      const key = this.getCouponStorageKey(this.activeUserId);
      if (this.couponSignal()) {
        localStorage.setItem(key, JSON.stringify(this.couponSignal()));
      } else {
        localStorage.removeItem(key);
      }
    } catch (e) {
      console.error('Could not save coupon:', e);
    }
  }

  private resolveImageUrl(rawUrl: string | undefined | null): string {
    if (!rawUrl) return 'https://placehold.co/600x600?text=Shoe';
    if (rawUrl.startsWith('http')) return rawUrl;
    const base = environment.apiUrl.replace(/\/api$/, '');
    return `${base}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
  }

  private mapBackendCart(cartDto: any): CartItem[] {
    const items = Array.isArray(cartDto?.items) ? cartDto.items : [];
    return items.map((item: any) => {
      const numericSize = Number(String(item.size || '').replace(/[^0-9.]/g, '')) || 8;
      const product: Product = {
        id: String(item.productId),
        name: item.productName || 'Footwear',
        brand: item.productBrand || 'StepStyle',
        category: 'chappals',
        price: Number(item.unitPrice || 0),
        originalPrice: Number(item.unitPrice || 0),
        discountPercentage: 0,
        description: '',
        images: [this.resolveImageUrl(item.productImageUrl)],
        sizes: [numericSize],
        colors: [{ name: item.color || 'Standard', hex: '#808080' }],
        rating: 0,
        reviewCount: 0,
        inStock: item.inStock ?? true,
        stockCount: Number(item.availableStock ?? 10)
      };

      return {
        id: String(item.id),
        product,
        selectedSize: numericSize,
        selectedColor: item.color || 'Standard',
        quantity: Number(item.quantity || 1),
        unitPrice: Number(item.unitPrice || 0),
        subtotal: Number(item.subtotal || 0)
      };
    });
  }

  public loadCartFromBackend(): void {
    if (!this.isBrowser || !this.authService.isLoggedIn()) {
      this.itemsSignal.set([]);
      return;
    }

    this.http.get<any>(this.cartApiUrl).subscribe({
      next: res => {
        this.itemsSignal.set(this.mapBackendCart(res));
      },
      error: () => {
        this.itemsSignal.set([]);
      }
    });
  }

  /**
   * Add footwear to the authenticated user's cart in Supabase via Spring Boot.
   */
  public addToCart(product: Product, size: number, color: string, quantity = 1): void {
    if (!this.authService.isLoggedIn()) {
      this.toastService.info('Please sign in to add items to your cart.', 'Login Required');
      this.router.navigate(['/login'], { queryParams: { returnUrl: this.router.url } });
      return;
    }

    const productId = Number(product.id);
    if (!Number.isFinite(productId) || productId <= 0) {
      this.toastService.error('This product is unavailable for online ordering right now.');
      return;
    }

    const payload = {
      productId,
      size: String(size),
      color: color || 'Standard',
      quantity
    };

    this.http.post<any>(`${this.cartApiUrl}/items`, payload).subscribe({
      next: res => {
        this.itemsSignal.set(this.mapBackendCart(res));
        this.toastService.success(`Added "${product.name}" (Size UK ${size}) to your Cart!`);
      },
      error: (err: HttpErrorResponse) => {
        const msg = err.error?.message || 'Could not add item to cart. Please try again.';
        this.toastService.error(msg);
      }
    });
  }

  /**
   * Increase item quantity in user's Supabase cart
   */
  public increaseQuantity(itemId: string): void {
    const item = this.itemsSignal().find(i => i.id === itemId);
    if (!item || !this.authService.isLoggedIn()) return;

    this.http.put<any>(`${this.cartApiUrl}/items/${encodeURIComponent(itemId)}`, {
      quantity: item.quantity + 1
    }).subscribe({
      next: res => {
        this.itemsSignal.set(this.mapBackendCart(res));
      },
      error: (err: HttpErrorResponse) => {
        const msg = err.error?.message || 'Could not update item quantity.';
        this.toastService.error(msg);
      }
    });
  }

  /**
   * Decrease item quantity in user's Supabase cart
   */
  public decreaseQuantity(itemId: string): void {
    const item = this.itemsSignal().find(i => i.id === itemId);
    if (!item || !this.authService.isLoggedIn()) return;

    if (item.quantity <= 1) {
      this.removeFromCart(itemId);
      return;
    }

    this.http.put<any>(`${this.cartApiUrl}/items/${encodeURIComponent(itemId)}`, {
      quantity: item.quantity - 1
    }).subscribe({
      next: res => {
        this.itemsSignal.set(this.mapBackendCart(res));
      },
      error: (err: HttpErrorResponse) => {
        const msg = err.error?.message || 'Could not update item quantity.';
        this.toastService.error(msg);
      }
    });
  }

  /**
   * Remove item completely from user's Supabase cart
   */
  public removeFromCart(itemId: string): void {
    if (!this.authService.isLoggedIn()) return;
    const item = this.itemsSignal().find(i => i.id === itemId);

    this.http.delete<any>(`${this.cartApiUrl}/items/${encodeURIComponent(itemId)}`).subscribe({
      next: res => {
        this.itemsSignal.set(this.mapBackendCart(res));
        if (item) {
          this.toastService.info(`Removed "${item.product.name}" from cart.`);
        }
      },
      error: (err: HttpErrorResponse) => {
        const msg = err.error?.message || 'Could not remove item from cart.';
        this.toastService.error(msg);
      }
    });
  }

  /**
   * Clear all items in user's Supabase cart
   */
  public clearCart(): void {
    if (!this.authService.isLoggedIn()) {
      this.itemsSignal.set([]);
      this.couponSignal.set(null);
      return;
    }

    this.http.delete<any>(this.cartApiUrl).subscribe({
      next: () => {
        this.itemsSignal.set([]);
        this.couponSignal.set(null);
        this.saveCouponForUser();
      },
      error: () => {
        this.itemsSignal.set([]);
        this.couponSignal.set(null);
        this.saveCouponForUser();
      }
    });
  }

  /**
   * Apply discount coupon code (stored per user)
   */
  public applyCoupon(code: string): { success: boolean; message: string } {
    const cleanCode = code.trim().toUpperCase();
    const matched = VALID_COUPONS.find(c => c.code === cleanCode);

    if (!matched) {
      this.toastService.error(`Coupon "${code}" is invalid or expired.`);
      return { success: false, message: 'Invalid coupon code.' };
    }

    if (matched.minSpend && this.subtotal() < matched.minSpend) {
      const msg = `Minimum spend of ₹${matched.minSpend} required for coupon ${matched.code}.`;
      this.toastService.warning(msg);
      return { success: false, message: msg };
    }

    this.couponSignal.set(matched);
    this.saveCouponForUser();
    this.toastService.success(`Coupon "${matched.code}" applied successfully!`);
    return { success: true, message: matched.description };
  }

  /**
   * Remove coupon
   */
  public removeCoupon(): void {
    this.couponSignal.set(null);
    this.saveCouponForUser();
    this.toastService.info('Coupon removed.');
  }

  /**
   * Place an order via Spring Boot backend: POST /api/orders
   * Persists order strictly for the authenticated user in Supabase and clears their cart.
   */
  public checkoutOrder(address: ShippingAddress, paymentMethod: 'cod' | 'upi' | 'card' | 'netbanking'): Observable<Order> {
    if (!this.authService.isLoggedIn()) {
      return throwError(() => new Error('Please sign in to place an order.'));
    }

    const currentItemsSnapshot = [...this.itemsSignal()];
    const currentSummarySnapshot = this.summary();

    const payload = {
      shippingAddress: `${address.addressLine1}, ${address.city}, ${address.state} - ${address.pincode}`,
      recipientName: address.fullName,
      recipientPhone: address.phone,
      paymentMethod: paymentMethod.toUpperCase()
    };

    return this.http.post<any>(this.ordersApiUrl, payload).pipe(
      map(res => {
        const orderData = res?.data || res || {};
        return {
          id: orderData.orderNumber || String(orderData.id || ''),
          orderDate: orderData.orderDate ? new Date(orderData.orderDate) : new Date(),
          items: currentItemsSnapshot,
          summary: {
            ...currentSummarySnapshot,
            grandTotal: Number(orderData.totalAmount ?? currentSummarySnapshot.grandTotal)
          },
          shippingAddress: address,
          paymentMethod,
          status: 'confirmed' as const
        };
      }),
      tap(() => {
        this.itemsSignal.set([]);
        this.couponSignal.set(null);
        this.saveCouponForUser();
      }),
      catchError((err: HttpErrorResponse) => {
        const msg = err.error?.message || 'Could not place order. Please try again.';
        return throwError(() => new Error(msg));
      })
    );
  }

  /**
   * Fetch orders placed ONLY by the currently logged-in customer.
   */
  public getMyOrders(): Observable<any[]> {
    return this.http.get<any[]>(`${this.ordersApiUrl}/my-orders`);
  }
}
