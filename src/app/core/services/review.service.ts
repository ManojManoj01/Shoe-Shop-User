import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, map, tap, timeout } from 'rxjs/operators';
import { environment } from '../../../environments/environment';

export interface ProductReview {
  id: string;
  productId: string;
  reviewerName: string;
  rating: number; // 1 to 5
  comment: string;
  createdAt: string;
}

export interface ReviewStats {
  rating: number;
  reviewCount: number;
}

const STORAGE_KEY = 'palani_product_reviews_map';

function readStorageMap(): Record<string, ProductReview[]> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function writeStorageMap(mapData: Record<string, ProductReview[]>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mapData));
  } catch (e) {
    // Ignore storage quota errors
  }
}

export function getLocalReviews(productId: string): ProductReview[] {
  const map = readStorageMap();
  return map[String(productId)] || [];
}

export function saveLocalReview(productId: string, review: ProductReview): ProductReview[] {
  const map = readStorageMap();
  const list = map[String(productId)] || [];
  const updated = [review, ...list];
  map[String(productId)] = updated;
  writeStorageMap(map);
  return updated;
}

export function computeReviewStats(productId: string): ReviewStats {
  const reviews = getLocalReviews(productId);
  if (reviews.length === 0) {
    return { rating: 0, reviewCount: 0 };
  }
  const total = reviews.reduce((acc, r) => acc + (Number(r.rating) || 0), 0);
  const avg = Math.round((total / reviews.length) * 10) / 10;
  return {
    rating: avg,
    reviewCount: reviews.length
  };
}

@Injectable({
  providedIn: 'root'
})
export class ReviewService {
  private http = inject(HttpClient);
  private apiUrl = `${(environment.apiUrl || 'https://shoe-shop-backend-1-fpu4.onrender.com').replace(/\/api\/?$/, '')}/api/products`;

  public getReviews(productId: string): Observable<ProductReview[]> {
    const local = getLocalReviews(productId);

    return this.http.get<any[]>(`${this.apiUrl}/${encodeURIComponent(productId)}/reviews`).pipe(
      timeout(2000),
      map(remoteList => {
        if (!Array.isArray(remoteList) || remoteList.length === 0) {
          return local;
        }
        // Map backend DTO to ProductReview
        const mapped: ProductReview[] = remoteList.map(r => ({
          id: String(r.id),
          productId: String(r.productId || productId),
          reviewerName: r.reviewerName,
          rating: Number(r.rating),
          comment: r.comment,
          createdAt: r.createdAt || new Date().toISOString()
        }));

        // Merge with local storage ensuring unique IDs
        const existingIds = new Set(mapped.map(m => m.id));
        for (const loc of local) {
          if (!existingIds.has(loc.id)) {
            mapped.push(loc);
          }
        }
        mapped.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        const mapData = readStorageMap();
        mapData[String(productId)] = mapped;
        writeStorageMap(mapData);

        return mapped;
      }),
      catchError(() => {
        return of(local);
      })
    );
  }

  public addReview(
    productId: string,
    data: { reviewerName: string; rating: number; comment: string }
  ): Observable<{ review: ProductReview; stats: ReviewStats }> {
    const newReview: ProductReview = {
      id: `rev_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      productId: String(productId),
      reviewerName: data.reviewerName.trim(),
      rating: Math.min(5, Math.max(1, Math.round(data.rating))),
      comment: data.comment.trim(),
      createdAt: new Date().toISOString()
    };

    // Save locally immediately
    saveLocalReview(productId, newReview);
    const updatedStats = computeReviewStats(productId);

    // Also attempt to sync with backend
    return this.http.post<any>(`${this.apiUrl}/${encodeURIComponent(productId)}/reviews`, {
      reviewerName: newReview.reviewerName,
      rating: newReview.rating,
      comment: newReview.comment
    }).pipe(
      timeout(2500),
      map(backendRes => {
        if (backendRes?.id) {
          newReview.id = String(backendRes.id);
        }
        const finalStats: ReviewStats = {
          rating: backendRes?.productRating != null ? Number(backendRes.productRating) : updatedStats.rating,
          totalReviews: backendRes?.totalReviews != null ? Number(backendRes.totalReviews) : updatedStats.reviewCount
        } as any;
        return {
          review: newReview,
          stats: {
            rating: finalStats.rating,
            reviewCount: (finalStats as any).totalReviews ?? updatedStats.reviewCount
          }
        };
      }),
      catchError(() => {
        // Backend offline or error: local save already succeeded
        return of({
          review: newReview,
          stats: updatedStats
        });
      })
    );
  }

  public getStats(productId: string): ReviewStats {
    return computeReviewStats(productId);
  }
}
